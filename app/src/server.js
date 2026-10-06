const path = require('path');
const crypto = require('crypto');
// Load repo-root .env when running natively (Docker passes env via compose; dotenv never overrides real env).
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const express = require('express');
const cron = require('node-cron');
const store = require('./store');
const { state, save, getSites, getOnCall } = store;
const { runAll, checkSite, checkForm } = require('./checks');
const { postCard } = require('./teams');
const { syncToKuma, pullStats, kumaStatus, verifyKumaLogin, getCreds, clearCreds, passwordProblem, kumaUrl, hookBase } = require('./kuma');

const PORT = Number(process.env.PORT || 3001);
const TZ = process.env.TZ || 'Asia/Kolkata';
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// 1) Uptime Kuma -> watchdog -> Teams  (real-time outages, cert notices)
//    Kuma notification type "Webhook", URL: http://watchdog:3001/hooks/kuma?token=HOOK_TOKEN
// ---------------------------------------------------------------------------
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y);
}

function parseKumaTime(t) {
  if (!t) return null;
  const s = String(t).replace(' ', 'T');
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z'); // Kuma v1 stores UTC
  return isNaN(d) ? null : d.getTime();
}

app.post('/hooks/kuma', async (req, res) => {
  if (!process.env.HOOK_TOKEN || !safeEq(req.query.token, process.env.HOOK_TOKEN)) return res.status(401).end();
  const receivedAt = Date.now();
  const { heartbeat, monitor, msg } = req.body || {};

  // Test button / certificate-expiry notices arrive without a heartbeat
  if (!heartbeat) {
    const r = await postCard({ title: monitor?.name ? `Notice: ${monitor.name}` : 'Watchdog notice', text: msg || 'Message from Uptime Kuma', color: 'Accent' }, { event: 'notice', sites: monitor?.name ? [monitor.name] : null });
    return res.json({ ok: r.ok });
  }

  const name = monitor?.name || 'Unknown monitor';
  const down = Number(heartbeat.status) === 0;
  const detectedAt = parseKumaTime(heartbeat.time) || receivedAt;
  const prev = state.uptime[name];

  const facts = [
    ['Site', name],
    ['URL', monitor?.url || '-'],
    ['Reason', heartbeat.msg || msg || '-'],
    ['Detected', new Date(detectedAt).toLocaleString('en-IN', { timeZone: TZ })],
  ];
  let downtimeMin = null;
  if (!down && prev?.status === 'down' && prev.since) {
    downtimeMin = Math.max(1, Math.round((detectedAt - new Date(prev.since).getTime()) / 60000));
    facts.push(['Downtime', `${downtimeMin} min`]);
  }

  const sent = await postCard({
    title: down ? `DOWN: ${name}` : `Back up: ${name}`,
    facts,
    color: down ? 'Attention' : 'Good',
  }, { event: down ? 'down' : 'up', sites: [name] });
  const deliveredAt = Date.now();

  // Detect->Teams pipeline time, plus worst-case outage->alert (outage could start right after last good check)
  const interval = Number(monitor?.interval) || 60;
  const retries = Number(monitor?.maxretries) || 0;
  const retryInterval = Number(monitor?.retryInterval) || interval;
  const pipelineSeconds = Math.max(0, Math.round((deliveredAt - detectedAt) / 1000));
  const worstCaseSeconds = pipelineSeconds + interval + retries * retryInterval;

  state.alerts.unshift({
    id: crypto.randomUUID(),
    site: name,
    url: monitor?.url,
    type: down ? 'down' : 'up',
    reason: heartbeat.msg || msg || '',
    detectedAt: new Date(detectedAt).toISOString(),
    deliveredAt: new Date(deliveredAt).toISOString(),
    pipelineSeconds,
    worstCaseSeconds: down ? worstCaseSeconds : null,
    downtimeMin,
    delivered: sent.ok,
    skipped: !!sent.reason, // no destination was set up for this alert
    deliveredTo: Object.values(sent.results || {}).filter((r) => r.ok).map((r) => r.name),
    onCall: getOnCall()?.name || null,
  });
  state.alerts = state.alerts.slice(0, 500);
  state.uptime[name] = {
    status: down ? 'down' : 'up',
    since: new Date(detectedAt).toISOString(),
    reason: heartbeat.msg || '',
    url: monitor?.url,
  };
  save();
  res.json({ ok: sent.ok });
});

// ---------------------------------------------------------------------------
// 2) Daily checks (SSL, domain, noindex/robots, form) -> one Teams digest
// ---------------------------------------------------------------------------
async function runDailyChecks(trigger = 'schedule') {
  if (state.running) return { skipped: true };
  state.running = true;
  const started = Date.now();
  try {
    const sites = getSites();
    const results = await runAll(sites, 5, state.sites);
    results.forEach(store.recordResult);
    state.lastRun = { at: new Date().toISOString(), trigger, seconds: Math.round((Date.now() - started) / 1000), count: results.length };
    save();

    const bad = results.filter((r) => r.status !== 'ok');
    console.log(`[checks] ${results.length} sites, ${bad.length} with issues (${trigger})`);
    // The automatic first-boot run only fills the dashboard; it never posts to Teams.
    if (bad.length && trigger !== 'first boot') {
      await postCard({
        title: `Daily check: ${bad.length} of ${results.length} sites need attention`,
        color: bad.some((r) => r.status === 'critical') ? 'Attention' : 'Warning',
        facts: bad.map((r) => [r.name, r.issues.map((i) => i.text).join('; ')]),
      }, { event: 'daily', sites: bad.map((r) => r.name) });
    }
    return { ok: true, total: results.length, issues: bad.length };
  } catch (e) {
    console.error('[checks] run failed', e);
    await postCard({ title: 'Watchdog daily check crashed', text: e.message, color: 'Attention' }, { event: 'daily' });
    return { ok: false, error: e.message };
  } finally {
    state.running = false;
  }
}

cron.schedule(process.env.CHECK_CRON || '0 9 * * *', () => runDailyChecks('schedule'), { timezone: TZ });

// ---------------------------------------------------------------------------
// 3) Dashboard (basic auth)
// ---------------------------------------------------------------------------
// Signed, stateless session cookie. Sign in with the Uptime Kuma account (or the DASH_USER/DASH_PASS from .env).
const SESSION_DAYS = 7;
const secret = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update(`${process.env.HOOK_TOKEN}|${process.env.DASH_PASS}`).digest('hex');
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');
function makeSession(user) {
  const p = Buffer.from(JSON.stringify({ u: user, e: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  return `${p}.${sign(p)}`;
}
function readSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)wd_session=([^;]+)/);
  if (!m) return null;
  const [p, sig] = m[1].split('.');
  if (!p || !sig || !safeEq(sig, sign(p))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    return o.e > Date.now() ? o : null;
  } catch {
    return null;
  }
}
function basicOk(req) {
  const { DASH_USER, DASH_PASS } = process.env;
  if (!DASH_USER || !DASH_PASS) return false;
  const [type, b64] = (req.headers.authorization || '').split(' ');
  const decoded = Buffer.from(b64 || '', 'base64').toString();
  const i = decoded.indexOf(':'); // password may contain ':'
  return type === 'Basic' && i >= 0 && safeEq(decoded.slice(0, i), DASH_USER) && safeEq(decoded.slice(i + 1), DASH_PASS);
}

function auth(req, res, next) {
  if (readSession(req) || basicOk(req)) return next(); // Basic stays valid for scripts and curl
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect('/login');
  res.status(401).json({ error: 'Login required' });
}

const tries = new Map(); // ip -> [timestamps]; 10 attempts per minute
app.post('/api/login', async (req, res) => {
  const now = Date.now();
  const recent = (tries.get(req.ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  tries.set(req.ip, [...recent, now]);

  const { user, pass } = req.body || {};
  const { DASH_USER, DASH_PASS } = process.env;
  let ok = !!(DASH_USER && DASH_PASS && safeEq(user, DASH_USER) && safeEq(pass, DASH_PASS));
  if (!ok) ok = await verifyKumaLogin(user, pass).catch(() => false);
  if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
  res.set('Set-Cookie', `wd_session=${makeSession(String(user))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', 'wd_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});
// Public: lets the login page know whether Kuma still needs its first account.
app.get('/api/login-info', async (req, res) => {
  const st = await kumaStatus();
  res.json({ needSetup: !!st.needSetup, kumaReachable: st.reachable, kumaUrl: process.env.KUMA_UI_URL || 'http://localhost:3000' });
});
app.get('/api/session', (req, res) => {
  const ses = readSession(req);
  ses || basicOk(req) ? res.json({ user: ses?.u || process.env.DASH_USER }) : res.status(401).json({ error: 'Login required' });
});
app.get('/login', (req, res) => (readSession(req) ? res.redirect('/') : res.sendFile(path.join(__dirname, '..', 'public', 'login.html'))));

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(auth);
app.use(express.static(path.join(__dirname, '..', 'public')));

// Pull live numbers from Kuma (only when its login is saved). Runs at start, after sync, then every 2 minutes.
let pulling = false;
async function refreshKumaStats() {
  if (pulling || !getCreds()) return;
  pulling = true;
  try {
    const stats = await pullStats();
    if (!stats) return;
    state.kumaStats = stats;
    for (const s of getSites()) {
      const k = stats[s.name];
      if (!k || (k.status !== 0 && k.status !== 1)) continue;
      const cur = state.uptime[s.name];
      const status = k.status === 0 ? 'down' : 'up';
      if (cur?.status !== status) state.uptime[s.name] = { status, since: new Date().toISOString(), reason: k.reason, url: s.url };
    }
    save();
  } catch (e) {
    console.error('[kuma] stats pull failed:', e.message);
  } finally {
    pulling = false;
  }
}
setInterval(refreshKumaStats, 120000).unref();
setTimeout(refreshKumaStats, 3000).unref();

function siteView(s) {
  const r = state.sites[s.name] || {};
  const up = state.uptime[s.name] || null;
  const paused = s.active === false;
  const ks = state.kumaStats[s.name];
  return {
    ...r,
    name: s.name, client: s.client || '', url: s.url, domain: s.domain || r.domain || '', domainCustom: s.domain || '', form_config: s.form || null,
    active: !paused,
    status: paused ? 'paused' : r.status || 'none',
    uptime: up,
    uptimePct: ks?.uptime30 != null ? Math.round(ks.uptime30 * 10000) / 100 : store.uptimePct(s.name),
    uptimeSource: ks?.uptime30 != null ? 'kuma' : 'alerts',
    uptime24Pct: ks?.uptime24 != null ? Math.round(ks.uptime24 * 10000) / 100 : null,
    avgPingMs: ks?.avgPing != null ? Math.round(ks.avgPing) : null,
    avgResponseMs: store.avgResponseMs(s.name),
    history: store.historyStrip(s.name),
    noKumaEvents: !up && !ks && !state.alerts.some((a) => a.site === s.name),
  };
}

app.get('/api/status', (req, res) => {
  const sites = getSites().map(siteView);

  const since = Date.now() - 30 * 86400000;
  const downs = state.alerts.filter((a) => a.type === 'down' && new Date(a.detectedAt).getTime() > since);
  const worst = downs.map((a) => a.worstCaseSeconds).filter((n) => n != null);
  const pipe = downs.map((a) => a.pipelineSeconds).filter((n) => n != null);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const pcts = sites.filter((s) => s.active && s.uptimePct != null).map((s) => s.uptimePct);

  res.json({
    sites,
    onCall: getOnCall(),
    lastRun: state.lastRun,
    running: state.running,
    teamsConfigured: store.getDestinations().some((d) => d.enabled && d.url),
    alerts: state.alerts.slice(0, 40),
    metrics: {
      outages30d: downs.length,
      avgWorstCaseSeconds: avg(worst),
      avgPipelineSeconds: avg(pipe),
      maxWorstCaseSeconds: worst.length ? Math.max(...worst) : null,
      undelivered30d: downs.filter((a) => !a.delivered && !a.skipped).length,
      expiredNow: sites.filter((s) => (s.ssl?.days ?? 1) < 0 || (s.domainExpiry?.days ?? 1) < 0).length,
      avgUptimePct: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100 : null,
    },
  });
});

app.post('/api/run', async (req, res) => {
  if (state.running) return res.status(409).json({ error: 'Checks are already running' });
  runDailyChecks('manual');
  res.status(202).json({ started: true });
});

// ---- sites CRUD (name is the key; it must match the Uptime Kuma monitor name) ----
const findSite = (list, name) => list.findIndex((s) => s.name === name);

// When Kuma credentials are saved, new sites get their monitor automatically (fire-and-forget).
function autoSyncKuma() {
  if (!getCreds()) return;
  syncToKuma({ sites: getSites() }).then(
    (r) => { if (r.added.length) console.log(`[kuma] auto-added monitors: ${r.added.join(', ')}`); setTimeout(refreshKumaStats, 4000); },
    (e) => console.error('[kuma] auto-sync failed:', e.message)
  );
}

app.get('/api/sites', (req, res) => res.json(getSites()));

app.post('/api/sites', (req, res) => {
  const { site, errors } = store.validateSite(req.body);
  const list = getSites();
  if (site && findSite(list, site.name) >= 0) errors.push(`A site named "${site.name}" already exists`);
  if (errors.length) return res.status(400).json({ errors });
  list.push(site);
  store.saveSites(list);
  autoSyncKuma();
  res.status(201).json(site);
});

app.put('/api/sites/:name', (req, res) => {
  const list = getSites();
  const i = findSite(list, req.params.name);
  if (i < 0) return res.status(404).json({ errors: ['Site not found'] });
  const { site, errors } = store.validateSite({ active: list[i].active, ...req.body });
  if (site && site.name !== req.params.name && findSite(list, site.name) >= 0) errors.push(`A site named "${site.name}" already exists`);
  if (errors.length) return res.status(400).json({ errors });
  list[i] = site;
  store.saveSites(list);
  if (site.name !== req.params.name) {
    store.renameInState(req.params.name, site.name);
    store.renameInDestinations(req.params.name, site.name);
  }
  save();
  res.json(site);
});

app.delete('/api/sites/:name', (req, res) => {
  const list = getSites();
  const i = findSite(list, req.params.name);
  if (i < 0) return res.status(404).json({ errors: ['Site not found'] });
  list.splice(i, 1);
  store.saveSites(list);
  store.forgetSite(req.params.name);
  save();
  res.json({ ok: true });
});

app.post('/api/sites/:name/active', (req, res) => {
  const list = getSites();
  const i = findSite(list, req.params.name);
  if (i < 0) return res.status(404).json({ errors: ['Site not found'] });
  if (req.body?.active === false) list[i].active = false;
  else delete list[i].active;
  store.saveSites(list);
  res.json({ name: list[i].name, active: list[i].active !== false });
});

app.post('/api/sites/:name/check', async (req, res) => {
  const site = getSites().find((s) => s.name === req.params.name);
  if (!site) return res.status(404).json({ errors: ['Site not found'] });
  const r = await checkSite(site, state.sites[site.name]).catch((e) => ({
    name: site.name, url: site.url, checkedAt: new Date().toISOString(), status: 'critical', issues: [{ level: 'critical', text: `Check crashed: ${e.message}` }],
  }));
  store.recordResult(r);
  save();
  res.json(r);
});

// Runs only the form check. Body may carry an unsaved form config (from the editor) to try before saving.
app.post('/api/sites/:name/test-form', async (req, res) => {
  const site = getSites().find((s) => s.name === req.params.name);
  if (!site) return res.status(404).json({ errors: ['Site not found'] });
  let form = site.form;
  if (req.body?.form) {
    const v = store.validateSite({ name: site.name, url: site.url, form: req.body.form });
    if (v.errors.length) return res.status(400).json({ errors: v.errors });
    form = v.site.form;
  }
  if (!form) return res.json({ skipped: true });
  try {
    res.json(await checkForm({ ...site, form }));
  } catch (e) {
    res.json({ ok: false, error: e.cause?.code || e.message });
  }
});

// ---- on-call rota ----
app.get('/api/oncall', (req, res) => res.json({ list: store.getOnCallList(), current: getOnCall() }));

app.post('/api/oncall', (req, res) => {
  const { person, errors } = store.validateOnCall(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const list = store.getOnCallList();
  list.push(person);
  list.sort((a, b) => (a.from || '').localeCompare(b.from || ''));
  store.saveOnCallList(list);
  res.status(201).json(person);
});

app.delete('/api/oncall/:index', (req, res) => {
  const list = store.getOnCallList();
  const i = Number(req.params.index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return res.status(404).json({ errors: ['Entry not found'] });
  list.splice(i, 1);
  store.saveOnCallList(list);
  res.json({ ok: true });
});

// ---- Uptime Kuma sync ----
app.get('/api/kuma/info', (req, res) => {
  const hook = `${hookBase()}/hooks/kuma?token=${process.env.HOOK_TOKEN || ''}`;
  res.json({
    url: kumaUrl(),
    uiUrl: process.env.KUMA_UI_URL || 'http://localhost:3000',
    hookUrl: hook,
    command: `pip install uptime-kuma-api\nKUMA_URL=${process.env.KUMA_UI_URL || 'http://localhost:3000'} KUMA_USER=admin KUMA_PASS='your-password' KUMA_NOTIFICATION_ID=1 python3 tools/add_monitors.py`,
  });
});

app.get('/api/kuma/status', async (req, res) => res.json(await kumaStatus()));

// Creates the first Kuma admin (when Kuma is brand new), connects the webhook, adds all sites, and remembers the login.
app.post('/api/kuma/setup', async (req, res) => {
  const { user, pass } = req.body || {};
  if (!String(user || '').trim()) return res.status(400).json({ error: 'Choose a username.' });
  const problem = passwordProblem(pass);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const r = await syncToKuma({ user: user.trim(), pass, sites: getSites(), remember: req.body.remember !== false });
    setTimeout(refreshKumaStats, 4000);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/kuma/sync', async (req, res) => {
  try {
    const r = await syncToKuma({ user: req.body?.user, pass: req.body?.pass, sites: getSites(), remember: !!req.body?.remember });
    setTimeout(refreshKumaStats, 4000);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete('/api/kuma/credentials', (req, res) => {
  clearCreds();
  res.json({ ok: true });
});

// ---- always-alert recipients (@mentioned on every Teams alert) ----
app.get('/api/recipients', (req, res) => res.json(store.getRecipients()));
app.post('/api/recipients', (req, res) => {
  const { person, errors } = store.validateRecipient(req.body);
  const list = store.getRecipients();
  if (list.some((p) => p.upn === person.upn)) errors.push('That person is already on the list');
  if (errors.length) return res.status(400).json({ errors });
  list.push(person);
  store.saveRecipients(list);
  res.status(201).json(person);
});
app.delete('/api/recipients/:index', (req, res) => {
  const list = store.getRecipients();
  const i = Number(req.params.index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return res.status(404).json({ errors: ['Entry not found'] });
  list.splice(i, 1);
  store.saveRecipients(list);
  res.json({ ok: true });
});

// ---- live updates: dashboard subscribes and refetches when anything changes ----
const streams = new Set();
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
});
let pending = null;
store.bus.on('change', () => {
  clearTimeout(pending);
  pending = setTimeout(() => streams.forEach((r) => r.write('event: change\ndata: {}\n\n')), 300);
});
setInterval(() => streams.forEach((r) => r.write(': ping\n\n')), 25000).unref();

// ---- Teams destinations: any number of group or personal chats, each with its own rules ----
app.get('/api/destinations', (req, res) => res.json(store.getDestinationsView()));
app.post('/api/destinations', (req, res) => {
  const r = store.addDestination(req.body);
  r.errors.length ? res.status(400).json({ errors: r.errors }) : res.status(201).json(r.dest);
});
app.put('/api/destinations/:id', (req, res) => {
  const r = store.updateDestination(req.params.id, req.body);
  r.errors.length ? res.status(r.notFound ? 404 : 400).json({ errors: r.errors }) : res.json(r.dest);
});
app.delete('/api/destinations/:id', (req, res) => {
  store.deleteDestination(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ errors: ['Destination not found'] });
});

const testCard = { title: 'Test alert from the watchdog dashboard', text: 'If you can read this, Teams alerts work.', color: 'Accent' };
// One test message to a single destination, whatever its rules say.
app.post('/api/destinations/:id/test', async (req, res) => {
  if (!store.getDestinations().some((d) => d.id === req.params.id)) return res.status(404).json({ errors: ['Destination not found'] });
  const r = await postCard(testCard, { event: 'test', only: req.params.id });
  res.status(r.ok ? 200 : 502).json(r.ok ? r : { error: r.error || 'Could not send', ...r });
});
// One test message to every destination that is switched on.
app.post('/api/test-alert', async (req, res) => {
  const r = await postCard(testCard, { event: 'test' });
  if (r.reason) return res.status(400).json({ error: 'Nothing to send to. Add a destination and switch it on first.' });
  res.status(r.ok ? 200 : 502).json(r.ok ? r : { error: r.error || 'Could not send', ...r });
});

app.listen(PORT, () => {
  console.log(`[watchdog] listening on :${PORT} (TZ ${TZ}, cron "${process.env.CHECK_CRON || '0 9 * * *'}")`);
  if (!state.lastRun) runDailyChecks('first boot');
});
