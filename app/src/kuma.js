// Port of tools/add_monitors.py: creates missing monitors in Uptime Kuma v1 through its socket.io API.
// Also creates the "Watchdog" webhook notification if no notification points at our hook yet.
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { DATA_DIR } = require('./store');

// Docker compose sets KUMA_URL / KUMA_HOOK_BASE to the internal service names; native runs use localhost.
// 127.0.0.1, not localhost: the websocket client can hang on the IPv6 address. host.docker.internal is how a Dockerised Kuma reaches a native watchdog.
const kumaUrl = () => process.env.KUMA_URL || 'http://127.0.0.1:3000';
const hookBase = () => process.env.KUMA_HOOK_BASE || `http://host.docker.internal:${process.env.PORT || 3001}`;

// Credentials are kept server-side only (data/kuma.json, owner-read-only) so new sites can sync automatically.
const CREDS_FILE = path.join(DATA_DIR, 'kuma.json');
function getCreds() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    return c.user && c.pass ? c : null;
  } catch {
    return null;
  }
}
function saveCreds(user, pass) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ user, pass }), { mode: 0o600 });
}
const clearCreds = () => fs.rmSync(CREDS_FILE, { force: true });

// Kuma's own password rule: 6+ chars with letters and numbers.
const passwordProblem = (p) =>
  !p || p.length < 8 ? 'Password must be at least 8 characters.' : !/[A-Za-z]/.test(p) || !/\d/.test(p) ? 'Password must contain both letters and numbers.' : null;

// True when Kuma accepts these credentials. Lets one Kuma account sign in to the dashboard too.
async function verifyKumaLogin(user, pass) {
  if (!user || !pass) return false;
  const sock = await connect();
  try {
    return !!(await emit(sock, 'login', { username: String(user), password: String(pass), token: '' }))?.ok;
  } finally {
    sock.close();
  }
}

// Reads what Kuma already knows: current up/down, 24h and 30-day uptime, average response time.
// Kuma pushes these events right after login, so the dashboard has real data the moment it is connected.
async function pullStats() {
  const creds = getCreds();
  if (!creds) return null;
  const sock = await connect();
  const last = {};
  const up = {};
  const ping = {};
  sock.on('heartbeatList', (id, list) => {
    if (Array.isArray(list) && list.length) last[id] = list[list.length - 1];
  });
  sock.on('uptime', (id, period, val) => ((up[id] ||= {})[period] = val));
  sock.on('avgPing', (id, val) => (ping[id] = val));
  try {
    const login = await emit(sock, 'login', { username: creds.user, password: creds.pass, token: '' });
    if (!login?.ok) throw new Error(login?.msg || 'Uptime Kuma login failed (saved password changed?)');
    const monitors = await waitFor(() => sock.lists.monitorList);
    if (!monitors) throw new Error('Uptime Kuma did not send its monitor list');
    await new Promise((r) => setTimeout(r, 2500)); // let the per-monitor stats arrive
    const out = {};
    for (const m of Object.values(monitors)) {
      const hb = last[m.id];
      out[m.name] = {
        status: hb ? Number(hb.status) : null, // 0 down, 1 up, 2 pending, 3 maintenance
        reason: hb?.msg || '',
        lastPing: hb?.ping ?? null,
        uptime24: up[m.id]?.[24] ?? null,
        uptime30: up[m.id]?.[720] ?? null,
        avgPing: ping[m.id] ?? null,
        active: m.active !== false,
        at: new Date().toISOString(),
      };
    }
    return out;
  } finally {
    sock.close();
  }
}

async function kumaStatus() {
  const creds = getCreds();
  let sock;
  try {
    sock = await connect();
  } catch (e) {
    return { reachable: false, error: e.message, connected: false, user: creds?.user || null };
  }
  try {
    const needSetup = !!(await emit(sock, 'needSetup'));
    return { reachable: true, needSetup, connected: !!creds && !needSetup, user: creds?.user || null };
  } finally {
    sock.close();
  }
}

const emit = (sock, ev, ...args) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Uptime Kuma did not answer "${ev}" in time`)), 20000);
    sock.emit(ev, ...args, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });

function connect() {
  return new Promise((resolve, reject) => {
    const sock = io(kumaUrl(), { transports: ['websocket'], reconnection: false, timeout: 8000 });
    sock.lists = { monitorList: null, notificationList: null };
    sock.on('monitorList', (m) => (sock.lists.monitorList = m));
    sock.on('notificationList', (n) => (sock.lists.notificationList = n));
    sock.once('connect', () => resolve(sock));
    sock.once('connect_error', (e) => reject(new Error(`Cannot reach Uptime Kuma at ${kumaUrl()} (${e.message})`)));
  });
}

const waitFor = async (get, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = get();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

async function syncToKuma({ user, pass, sites, remember = false }) {
  if (!user || !pass) ({ user, pass } = getCreds() || {});
  if (!user || !pass) throw new Error('Uptime Kuma username and password are required');
  const sock = await connect();
  const log = [];
  try {
    // First-run Kuma has no admin yet: create it with the credentials supplied.
    if (await emit(sock, 'needSetup')) {
      const s = await emit(sock, 'setup', user, pass);
      if (!s?.ok) throw new Error(s?.msg || 'Could not create the Uptime Kuma admin user');
      log.push(`Created Uptime Kuma admin "${user}"`);
    }
    const login = await emit(sock, 'login', { username: user, password: pass, token: '' });
    if (!login?.ok) throw new Error(login?.msg || 'Uptime Kuma login failed');

    const monitors = await waitFor(() => sock.lists.monitorList);
    const notifications = (await waitFor(() => sock.lists.notificationList)) || [];
    if (!monitors) throw new Error('Uptime Kuma did not send its monitor list');

    // 1) webhook notification pointing at this watchdog
    const hookUrl = `${hookBase()}/hooks/kuma?token=${process.env.HOOK_TOKEN}`;
    let notifId = null;
    for (const n of Array.isArray(notifications) ? notifications : Object.values(notifications)) {
      try {
        const cfg = JSON.parse(n.config || '{}');
        if (cfg.type === 'webhook' && String(cfg.webhookURL || '').includes('/hooks/kuma')) notifId = n.id;
      } catch {
        /* ignore */
      }
    }
    if (!notifId) {
      const r = await emit(sock, 'addNotification', {
        name: 'Watchdog (Teams relay)', type: 'webhook', webhookURL: hookUrl, webhookContentType: 'json',
        isDefault: true, applyExisting: true, active: true,
      }, null);
      if (!r?.ok) throw new Error(r?.msg || 'Could not create the webhook notification');
      notifId = r.id;
      log.push('Created webhook notification "Watchdog (Teams relay)"');
    }

    // 2) monitors
    const existing = new Set(Object.values(monitors).map((m) => m.name));
    const added = [];
    const skipped = [];
    const failed = [];
    for (const s of sites.filter((x) => x.active !== false)) {
      if (existing.has(s.name)) {
        skipped.push(s.name);
        continue;
      }
      const r = await emit(sock, 'add', {
        type: 'http', name: s.name, url: s.url, method: 'GET', interval: 30, retryInterval: 20, resendInterval: 0,
        maxretries: 1, timeout: 24, ignoreTls: false, upsideDown: false, expiryNotification: true, maxredirects: 10,
        accepted_statuscodes: ['200-299'], notificationIDList: { [notifId]: true }, dns_resolve_type: 'A',
        dns_resolve_server: '1.1.1.1', proxyId: null, active: true,
      });
      if (r?.ok) added.push(s.name);
      else failed.push({ name: s.name, error: r?.msg || 'unknown error' });
    }
    if (remember) saveCreds(user, pass);
    return { added, skipped, failed, notificationId: notifId, log };
  } finally {
    sock.close();
  }
}

module.exports = { syncToKuma, pullStats, kumaStatus, verifyKumaLogin, getCreds, clearCreds, passwordProblem, kumaUrl, hookBase };
