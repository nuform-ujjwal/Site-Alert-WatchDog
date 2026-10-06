const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const bus = new EventEmitter(); // emits 'change' whenever state or config is saved (drives live dashboard updates)

// Defaults resolve relative to the repo (app/src -> ../../config), so it works natively and on Windows.
// Docker sets CONFIG_DIR=/config and DATA_DIR=/data explicitly via compose.
const REPO = path.join(__dirname, '..', '..');
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(REPO, 'config');
const DATA_DIR = process.env.DATA_DIR || path.join(REPO, 'data');
const BACKUP_DIR = path.join(CONFIG_DIR, 'backups');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TZ = () => process.env.TZ || 'Asia/Kolkata';

// ---------- config (re-read every call, so edits apply without restart) ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[config] cannot read ${file}: ${e.message}`);
    return fallback;
  }
}

// Atomic write (temp + rename) with a timestamped backup of the previous version.
function writeConfig(file, data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const target = path.join(CONFIG_DIR, file);
  if (fs.existsSync(target)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(target, path.join(BACKUP_DIR, `${file}.${stamp}.bak`));
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(file + '.')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 50))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, target);
  bus.emit('change');
}

const getSites = () => readJson('sites.json', []);
const saveSites = (list) => writeConfig('sites.json', list);
const getOnCallList = () => readJson('oncall.json', []);
const saveOnCallList = (list) => writeConfig('oncall.json', list);

// settings.json: { alertRecipients: [{ name, upn }] } are @mentioned on every Teams alert, besides whoever is on call.
const getRecipients = () => {
  const s = readJson('settings.json', {});
  return Array.isArray(s.alertRecipients) ? s.alertRecipients : [];
};
const saveRecipients = (list) => writeConfig('settings.json', { ...readJson('settings.json', {}), alertRecipients: list });

function validateRecipient(p) {
  const out = { name: String(p?.name || '').trim(), upn: String(p?.upn || '').trim().toLowerCase() };
  const errors = [];
  if (!out.name) errors.push('Name is required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.upn)) errors.push('Enter the Teams email address (example: name@company.com)');
  return { person: out, errors };
}

// ---------- Teams destinations ----------
// Any number of Teams workflows (group chats or personal chats), managed from the dashboard.
// Stored in data/destinations.json (owner-only) because each one holds a secret link. Links never leave the server.
// Each destination decides: which alerts it gets, for which sites, and whether only while a given person is on call.
const DEST_FILE = path.join(DATA_DIR, 'destinations.json');
const EVENTS = ['down', 'up', 'daily', 'notice'];
const readFileJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const writeDest = (list) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DEST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DEST_FILE);
  bus.emit('change');
};
const newId = () => 'd' + Math.random().toString(36).slice(2, 10);

// One-time import of the older single-link setup (.env links and the on/off switches), so nothing is lost on upgrade.
function seedDestinations() {
  const legacy = readFileJson(path.join(DATA_DIR, 'teams.json')) || {};
  const flags = readJson('settings.json', {}).alertTargets || {};
  const defs = [
    { key: 'group', env: 'TEAMS_WEBHOOK_URL', name: 'Group chat', kind: 'group' },
    { key: 'personal', env: 'TEAMS_DM_WEBHOOK_URL', name: 'Personal chat', kind: 'personal' },
  ];
  return defs
    .map((d) => ({ d, url: legacy[d.key] || process.env[d.env] || '' }))
    .filter((x) => x.url)
    .map(({ d, url }) => ({
      id: newId(), name: d.name, kind: d.kind, url, enabled: flags[d.key] !== false,
      events: { down: true, up: true, daily: true, notice: true }, scope: 'all', sites: [], onCallOnly: '', mention: d.kind === 'group',
    }));
}

function getDestinations() {
  let list = readFileJson(DEST_FILE);
  if (!Array.isArray(list)) {
    list = seedDestinations();
    writeDest(list);
  }
  return list;
}

function validateDestination(input, existing) {
  const errors = [];
  const name = String(input?.name ?? existing?.name ?? '').trim();
  if (!name) errors.push('Give this destination a name');
  if (name.length > 60) errors.push('Name is too long (max 60)');
  const kind = input?.kind ?? existing?.kind ?? 'group';
  if (!['group', 'personal'].includes(kind)) errors.push('Type must be group chat or personal chat');
  let url = existing?.url || '';
  if (typeof input?.url === 'string' && input.url.trim()) {
    url = input.url.trim();
    if (!url.startsWith('https://') || !isHttpUrl(url)) errors.push('The Teams link must start with https://');
  }
  if (!url) errors.push('Paste the Teams link for this destination');
  const ev = { ...(existing?.events || { down: true, up: true, daily: true, notice: true }), ...(input?.events || {}) };
  const events = Object.fromEntries(EVENTS.map((e) => [e, ev[e] !== false]));
  if (!Object.values(events).some(Boolean)) errors.push('Pick at least one kind of alert');
  const scope = input?.scope ?? existing?.scope ?? 'all';
  const sites = Array.isArray(input?.sites) ? input.sites.map(String) : existing?.sites || [];
  if (!['all', 'sites'].includes(scope)) errors.push('Scope must be all sites or selected sites');
  if (scope === 'sites' && !sites.length) errors.push('Pick at least one site, or choose all sites');
  return {
    errors,
    dest: {
      id: existing?.id || newId(), name, kind, url,
      enabled: typeof input?.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true,
      events, scope, sites: scope === 'sites' ? sites : [],
      onCallOnly: String(input?.onCallOnly ?? existing?.onCallOnly ?? '').trim(),
      mention: typeof input?.mention === 'boolean' ? input.mention : existing?.mention ?? kind === 'group',
    },
  };
}

// What the dashboard may see: everything except the link itself.
const destView = (d) => ({ ...d, url: undefined, configured: !!d.url, hint: d.url ? '…' + d.url.slice(-6) : '' });
const getDestinationsView = () => getDestinations().map(destView);

function addDestination(input) {
  const { errors, dest } = validateDestination(input, null);
  if (errors.length) return { errors };
  writeDest([...getDestinations(), dest]);
  return { errors: [], dest: destView(dest) };
}
function updateDestination(id, input) {
  const list = getDestinations();
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return { errors: ['Destination not found'], notFound: true };
  const { errors, dest } = validateDestination(input, list[i]);
  if (errors.length) return { errors };
  list[i] = dest;
  writeDest(list);
  return { errors: [], dest: destView(dest) };
}
function deleteDestination(id) {
  const list = getDestinations();
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return false;
  writeDest(next);
  return true;
}

const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ() }); // YYYY-MM-DD

function getOnCall() {
  const list = getOnCallList();
  const today = todayISO();
  return (
    list.find((p) => (!p.from || p.from <= today) && (!p.to || p.to >= today)) ||
    list[list.length - 1] ||
    null
  );
}

// ---------- validation ----------
const isHttpUrl = (u) => {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

function validateSite(s) {
  const errors = [];
  if (!s || typeof s !== 'object') return { errors: ['Site must be an object'] };
  const out = { name: String(s.name || '').trim(), client: String(s.client || '').trim(), url: String(s.url || '').trim() };
  if (!out.name) errors.push('Name is required');
  if (out.name.length > 100) errors.push('Name is too long (max 100)');
  if (!isHttpUrl(out.url)) errors.push('URL must start with http:// or https://');
  if (s.domain) {
    // accept pasted URLs or www. names: only the registered domain matters for expiry lookups
    out.domain = String(s.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[\/?#].*$/, '').replace(/^www\./, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(out.domain)) errors.push('Domain looks invalid (example: example.com)');
  }
  if (s.active === false) out.active = false;

  const f = s.form;
  if (f && f.mode && f.mode !== 'none') {
    if (!['presence', 'submit'].includes(f.mode)) errors.push('Form mode must be none, presence or submit');
    const form = { mode: f.mode, url: String(f.url || '').trim() };
    if (!isHttpUrl(form.url)) errors.push('Form URL must start with http:// or https://');
    if (f.expectText) form.expectText = String(f.expectText);
    if (f.mode === 'submit') {
      form.method = String(f.method || 'POST').toUpperCase();
      if (!['POST', 'PUT', 'PATCH'].includes(form.method)) errors.push('Form method must be POST, PUT or PATCH');
      form.type = f.type || 'urlencoded';
      if (!['urlencoded', 'multipart', 'json'].includes(form.type)) errors.push('Form type must be urlencoded, multipart or json');
      form.fields = {};
      for (const [k, v] of Object.entries(f.fields || {})) {
        if (String(k).trim()) form.fields[String(k).trim()] = String(v ?? '');
      }
      const es = Number(f.expectStatus || 200);
      if (!Number.isInteger(es) || es < 100 || es > 599) errors.push('Expected status must be 100-599');
      form.expectStatus = es;
      if (f.headers && typeof f.headers === 'object') form.headers = f.headers;
    }
    out.form = form;
  }
  return { site: out, errors };
}

function validateOnCall(p) {
  const errors = [];
  const out = { name: String(p?.name || '').trim(), upn: String(p?.upn || '').trim(), from: p?.from || '', to: p?.to || '' };
  if (!out.name) errors.push('Name is required');
  if (out.upn && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.upn)) errors.push('Teams email looks invalid');
  for (const k of ['from', 'to']) if (out[k] && !/^\d{4}-\d{2}-\d{2}$/.test(out[k])) errors.push(`${k} must be YYYY-MM-DD`);
  if (out.from && out.to && out.from > out.to) errors.push('"From" must be on or before "To"');
  return { person: out, errors };
}

// ---------- state ----------
// history[name] = [{ date, status, issues }]  (last 30 days)
const state = { sites: {}, uptime: {}, alerts: [], history: {}, kumaStats: {}, lastRun: null, running: false };
try {
  Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')), { running: false });
} catch {
  /* first boot */
}
state.history = state.history || {};
state.kumaStats = state.kumaStats || {};

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  bus.emit('change');
}

// Store one site's check result + upsert today's history cell.
function recordResult(r) {
  state.sites[r.name] = r;
  const h = (state.history[r.name] ||= []);
  const cell = { date: todayISO(), status: r.status, issues: (r.issues || []).map((i) => i.text), ms: r.indexing?.responseMs ?? null };
  const i = h.findIndex((c) => c.date === cell.date);
  if (i >= 0) h[i] = cell;
  else h.push(cell);
  h.sort((a, b) => a.date.localeCompare(b.date));
  state.history[r.name] = h.slice(-30);
}

function renameInDestinations(from, to) {
  const list = getDestinations();
  let changed = false;
  for (const d of list) {
    const i = d.sites.indexOf(from);
    if (i >= 0) { d.sites[i] = to; changed = true; }
  }
  if (changed) writeDest(list);
}

function renameInState(from, to) {
  for (const key of ['sites', 'uptime', 'history', 'kumaStats']) {
    if (state[key][from] !== undefined) {
      state[key][to] = state[key][from];
      delete state[key][from];
    }
  }
  if (state.sites[to]) state.sites[to].name = to;
  for (const a of state.alerts) if (a.site === from) a.site = to;
}

function forgetSite(name) {
  for (const key of ['sites', 'uptime', 'history', 'kumaStats']) delete state[key][name];
}

// 30-day strip: array of 30 cells oldest -> newest, status or 'none'
function historyStrip(name) {
  const byDate = Object.fromEntries((state.history[name] || []).map((c) => [c.date, c]));
  const out = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toLocaleDateString('en-CA', { timeZone: TZ() });
    out.push({ date: d, status: byDate[d]?.status || 'none', issues: byDate[d]?.issues || [], ms: byDate[d]?.ms ?? null });
  }
  return out;
}

function avgResponseMs(name) {
  const v = (state.history[name] || []).map((c) => c.ms).filter((n) => typeof n === 'number');
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

// Uptime % over 30 days from down/up alert pairs. null when no alert has ever been seen for the site.
function uptimePct(name, days = 30) {
  const now = Date.now();
  const from = now - days * 86400000;
  const ev = state.alerts
    .filter((a) => a.site === name)
    .map((a) => ({ type: a.type, t: new Date(a.detectedAt).getTime() }))
    .sort((a, b) => a.t - b.t);
  if (!ev.length) return null;
  let downMs = 0;
  let downSince = null;
  // If the first event in window is "up", the site was down before the window started.
  const firstInWindow = ev.find((e) => e.t >= from);
  if (firstInWindow?.type === 'up') downSince = from;
  const before = ev.filter((e) => e.t < from).pop();
  if (before?.type === 'down') downSince = from;
  for (const e of ev.filter((x) => x.t >= from)) {
    if (e.type === 'down' && downSince === null) downSince = e.t;
    else if (e.type === 'up' && downSince !== null) {
      downMs += e.t - downSince;
      downSince = null;
    }
  }
  if (downSince !== null) downMs += now - downSince;
  return Math.max(0, Math.min(100, Math.round((1 - downMs / (now - from)) * 10000) / 100));
}

module.exports = {
  state, save, getSites, saveSites, getOnCall, getOnCallList, saveOnCallList,
  getDestinations, getDestinationsView, addDestination, updateDestination, deleteDestination,
  bus, getRecipients, saveRecipients, validateRecipient,
  validateSite, validateOnCall, recordResult, renameInState, renameInDestinations, forgetSite, historyStrip, uptimePct, avgResponseMs,
  CONFIG_DIR, DATA_DIR, BACKUP_DIR,
};
