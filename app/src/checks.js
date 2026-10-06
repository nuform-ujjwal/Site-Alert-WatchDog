const tls = require('tls');
const net = require('net');
const { execFile } = require('child_process');

const UA = 'NuformWatchdog/1.0 (+https://nuformsocial.com)';
const SSL_WARN = Number(process.env.SSL_WARN_DAYS || 14);
const DOMAIN_WARN = Number(process.env.DOMAIN_WARN_DAYS || 30);
const SLOW_MS = Number(process.env.SLOW_MS || 3000);

const daysUntil = (d) => Math.floor((new Date(d).getTime() - Date.now()) / 86400000);

function get(url, opts = {}, ms = 20000) {
  return fetch(url, {
    redirect: 'follow',
    ...opts,
    headers: { 'user-agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(ms),
  });
}

async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    return { error: e.cause?.code || e.message };
  }
}

// ---------- 1. SSL certificate ----------
function checkSSL(host) {
  return new Promise((resolve) => {
    const sock = tls.connect(
      { host, port: 443, servername: host, rejectUnauthorized: false, timeout: 15000 },
      () => {
        const cert = sock.getPeerCertificate();
        const authorized = sock.authorized;
        const authError = sock.authorizationError;
        sock.end();
        if (!cert || !cert.valid_to) return resolve({ error: 'No certificate returned' });
        resolve({
          days: daysUntil(cert.valid_to),
          expires: new Date(cert.valid_to).toISOString(),
          issuer: cert.issuer?.O || cert.issuer?.CN || null,
          valid: authorized,
          error: authorized ? null : String(authError),
        });
      }
    );
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ error: 'TLS timeout' });
    });
    sock.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

// ---------- 2. Domain expiry: RDAP (IANA bootstrap) -> rdap.org -> whois binary -> pure-Node WHOIS (port 43) ----------
const EXPIRY_RE =
  /(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiry Date|Expiration Date|Expiration Time|paid-till|Expires On|Expires)\s*:\s*(.+)/i;

let rdapBootstrap = null;
async function rdapServerFor(tld) {
  if (!rdapBootstrap) {
    const r = await get('https://data.iana.org/rdap/dns.json', {}, 10000);
    if (!r.ok) return null;
    rdapBootstrap = (await r.json()).services || [];
  }
  const hit = rdapBootstrap.find(([tlds]) => tlds.includes(tld));
  return hit ? hit[1][0] : null;
}

async function rdapExpiry(domain) {
  const tld = domain.split('.').pop();
  const urls = [];
  try {
    const base = await rdapServerFor(tld);
    if (base) urls.push(`${base.replace(/\/$/, '')}/domain/${domain}`);
  } catch {
    /* bootstrap unreachable, try rdap.org */
  }
  urls.push(`https://rdap.org/domain/${domain}`);
  for (const u of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await get(u, { headers: { accept: 'application/rdap+json' } }, 12000);
        if (!r.ok) break; // 404/302 etc: try the next server
        const j = await r.json();
        const ev = (j.events || []).find((e) => e.eventAction === 'expiration');
        if (ev) return { days: daysUntil(ev.eventDate), expires: new Date(ev.eventDate).toISOString(), source: 'rdap' };
        break;
      } catch {
        /* network blip: retry once */
      }
    }
  }
  return null;
}

function whoisQuery(server, query, ms = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: server, port: 43 });
    let out = '';
    sock.setTimeout(ms, () => sock.destroy(new Error(`whois timeout (${server})`)));
    sock.on('connect', () => sock.write(query + '\r\n'));
    sock.on('data', (d) => (out += d));
    sock.on('end', () => resolve(out));
    sock.on('close', () => resolve(out));
    sock.on('error', reject);
  });
}

function parseExpiry(out) {
  const m = out.match(EXPIRY_RE);
  if (!m) return null;
  const d = new Date(m[1].trim().replace(/\.$/, ''));
  return isNaN(d) ? null : d;
}

async function nodeWhois(domain) {
  const tld = domain.split('.').pop();
  const iana = await whoisQuery('whois.iana.org', tld);
  const refer = iana.match(/^\s*(?:refer|whois):\s*(\S+)/im)?.[1];
  if (!refer) throw new Error(`No WHOIS server for .${tld}`);
  let out = await whoisQuery(refer, domain);
  let d = parseExpiry(out);
  if (!d) {
    // thin registries (e.g. .com) refer to the registrar's server
    const next = out.match(/Registrar WHOIS Server:\s*(\S+)/i)?.[1];
    if (next && next.toLowerCase() !== refer.toLowerCase()) {
      out = await whoisQuery(next.replace(/^whois:\/\//, ''), domain);
      d = parseExpiry(out);
    }
  }
  if (!d) throw new Error('Expiry date not found in WHOIS response');
  return { days: daysUntil(d), expires: d.toISOString(), source: 'whois-tcp' };
}

function whoisBinary(domain) {
  return new Promise((resolve, reject) => {
    execFile('whois', [domain], { timeout: 20000 }, (err, out = '') => {
      if (err && err.code === 'ENOENT') return reject(err);
      const d = parseExpiry(out);
      if (!d) return reject(new Error(err ? `whois failed: ${err.message}` : 'Expiry date not found'));
      resolve({ days: daysUntil(d), expires: d.toISOString(), source: 'whois' });
    });
  });
}

async function checkDomain(domain) {
  const viaRdap = await rdapExpiry(domain);
  if (viaRdap) return viaRdap;
  // Pure-Node WHOIS first: the whois binary is missing on Windows and broken in slim Docker images.
  try {
    return await nodeWhois(domain);
  } catch (e) {
    const nodeErr = e.message;
    try {
      return await whoisBinary(domain);
    } catch {
      return { error: nodeErr };
    }
  }
}

// ---------- 3. noindex + robots.txt ----------
function robotsBlocksAll(txt) {
  let applies = false;
  let inUaBlock = false;
  let blocked = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line || !line.includes(':')) continue;
    const idx = line.indexOf(':');
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!inUaBlock) applies = false; // new group starts
      inUaBlock = true;
      if (val === '*' || /googlebot/i.test(val)) applies = true;
    } else {
      inUaBlock = false;
      if (applies && key === 'disallow' && val === '/') blocked = true;
      if (applies && key === 'allow' && val === '/') return false;
    }
  }
  return blocked;
}

async function checkIndexing(url) {
  const t0 = Date.now();
  const r = await get(url);
  const html = await r.text();
  const responseMs = Date.now() - t0;
  const header = (r.headers.get('x-robots-tag') || '').toLowerCase();
  const metaTags = [...html.matchAll(/<meta[^>]*name=["']?(?:robots|googlebot)["']?[^>]*>/gi)].map((m) => m[0]);
  const metaNoindex = metaTags.some((t) => /content=["'][^"']*noindex/i.test(t));

  let robotsBlocked = false;
  let robotsFound = false;
  try {
    const rr = await get(new URL('/robots.txt', r.url).href);
    if (rr.ok) {
      robotsFound = true;
      robotsBlocked = robotsBlocksAll(await rr.text());
    }
  } catch {
    /* robots.txt missing/unreachable is not an error */
  }

  return {
    httpStatus: r.status,
    responseMs,
    noindex: header.includes('noindex') || metaNoindex,
    noindexSource: header.includes('noindex') ? 'X-Robots-Tag header' : metaNoindex ? 'meta robots tag' : null,
    robotsFound,
    robotsBlocked,
  };
}

// ---------- 3b. http -> https redirect, sitemap.xml ----------
async function checkHttpsRedirect(siteUrl) {
  const u = new URL(siteUrl);
  if (u.protocol !== 'https:') return { skipped: true };
  try {
    const r = await get(`http://${u.host}/`, { redirect: 'manual' }, 10000);
    const loc = r.headers.get('location') || '';
    return { ok: [301, 302, 307, 308].includes(r.status) && loc.startsWith('https://'), status: r.status };
  } catch (e) {
    return { error: e.cause?.code || e.message }; // port 80 closed: cannot tell, not treated as a problem
  }
}

async function checkSitemap(siteUrl) {
  try {
    const r = await get(new URL('/sitemap.xml', siteUrl).href, {}, 10000);
    const t = r.ok ? await r.text() : '';
    return { found: r.ok && /<(urlset|sitemapindex)/i.test(t) };
  } catch {
    return { found: false };
  }
}

// ---------- 4. Form ----------
async function checkForm(site) {
  const f = site.form;
  if (!f) return { skipped: true };

  if (f.mode === 'presence') {
    const r = await get(f.url);
    const t = await r.text();
    const needle = f.expectText || '<form';
    const ok = r.ok && t.includes(needle);
    return { ok, mode: 'presence', httpStatus: r.status, error: ok ? null : `"${needle}" not found on ${f.url}` };
  }

  let body;
  const headers = { ...(f.headers || {}) };
  if (f.type === 'json') {
    body = JSON.stringify(f.fields || {});
    headers['content-type'] = 'application/json';
  } else if (f.type === 'multipart') {
    body = new FormData();
    for (const [k, v] of Object.entries(f.fields || {})) body.append(k, v);
  } else {
    body = new URLSearchParams(f.fields || {});
  }

  const r = await get(f.url, { method: f.method || 'POST', body, headers });
  const t = await r.text();
  const statusOk = r.status === (f.expectStatus || 200);
  const textOk = !f.expectText || t.includes(f.expectText);
  return {
    ok: statusOk && textOk,
    mode: 'submit',
    httpStatus: r.status,
    error: statusOk && textOk ? null : !statusOk ? `HTTP ${r.status}` : `"${f.expectText}" not in response`,
  };
}

// ---------- per site ----------
async function checkSite(site, prev) {
  const u = new URL(site.url);
  const domain = (site.domain || u.hostname).toLowerCase().replace(/^www\./, '');
  const [ssl, dom0, idx, form, https, sitemap] = await Promise.all([
    checkSSL(u.hostname),
    checkDomain(domain),
    safe(() => checkIndexing(site.url)),
    safe(() => checkForm(site)),
    checkHttpsRedirect(site.url),
    checkSitemap(site.url),
  ]);
  // Domain expiry barely changes: if today's lookup failed, keep the last known date instead of showing "Unknown".
  const dom =
    dom0.days === undefined && prev?.domainExpiry?.expires
      ? { days: daysUntil(prev.domainExpiry.expires), expires: prev.domainExpiry.expires, source: prev.domainExpiry.source, stale: true, staleReason: dom0.error }
      : dom0;

  const issues = [];
  const add = (level, text) => issues.push({ level, text });

  if (ssl.days === undefined) add('critical', `SSL check failed: ${ssl.error}`);
  else if (ssl.days < 0) add('critical', `SSL expired ${-ssl.days} days ago`);
  else if (ssl.error) add('critical', `SSL invalid: ${ssl.error}`);
  else if (ssl.days <= SSL_WARN) add('warning', `SSL expires in ${ssl.days} days`);

  if (dom.days === undefined) add('warning', `Domain expiry unknown: ${dom.error}`);
  else if (dom.days < 0) add('critical', `Domain expired ${-dom.days} days ago`);
  else if (dom.days <= DOMAIN_WARN) add('warning', `Domain expires in ${dom.days} days`);

  if (idx.error) add('critical', `Homepage unreachable: ${idx.error}`);
  else {
    if (idx.httpStatus >= 400) add('critical', `Homepage returned HTTP ${idx.httpStatus}`);
    if (idx.noindex) add('critical', `noindex found (${idx.noindexSource})`);
    if (idx.robotsBlocked) add('critical', 'robots.txt blocks the whole site (Disallow: /)');
    if (idx.responseMs > SLOW_MS) add('warning', `Homepage is slow (${(idx.responseMs / 1000).toFixed(1)} s to load)`);
  }
  if (https.ok === false) add('warning', 'http:// version does not redirect to https://');

  if (form.error && form.ok === undefined) add('critical', `Form check failed: ${form.error}`);
  else if (form.ok === false) add('critical', `Form broken: ${form.error}`);

  return {
    name: site.name,
    client: site.client || '',
    url: site.url,
    domain,
    checkedAt: new Date().toISOString(),
    ssl,
    domainExpiry: dom,
    indexing: idx,
    https,
    sitemap,
    form,
    issues,
    status: issues.some((i) => i.level === 'critical') ? 'critical' : issues.length ? 'warning' : 'ok',
  };
}

async function runAll(allSites, concurrency = 5, prevMap = {}) {
  const sites = allSites.filter((s) => s.active !== false); // paused sites are skipped
  const results = [];
  for (let i = 0; i < sites.length; i += concurrency) {
    const batch = sites.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map((s) => checkSite(s, prevMap[s.name]).catch((e) => ({
      name: s.name, url: s.url, checkedAt: new Date().toISOString(),
      issues: [{ level: 'critical', text: `Check crashed: ${e.message}` }], status: 'critical',
    }))))));
  }
  return results;
}

module.exports = { runAll, checkSite, checkForm, checkDomain, nodeWhois, robotsBlocksAll };
