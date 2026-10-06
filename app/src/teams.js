const { getOnCall, getRecipients, getDestinations } = require('./store');

// Who is mentioned: the person on call plus the always-alert people (deduped by email).
function mentionPeople() {
  const onCall = getOnCall();
  const people = [];
  const seen = new Set();
  for (const p of [onCall, ...getRecipients()]) {
    if (!p?.upn || seen.has(p.upn.toLowerCase())) continue;
    seen.add(p.upn.toLowerCase());
    people.push(p);
  }
  return { onCall, people };
}

// color: 'Attention' (red) | 'Warning' (orange) | 'Good' (green) | 'Accent' (blue)
// dest.mention true: real Teams @mentions. false: plain names (for example a personal chat that is already the person's own).
function buildCard({ title, text, facts, color }, dest) {
  const { onCall, people } = mentionPeople();
  const tag = (p) => (dest.mention && p.upn ? `<at>${p.name}</at>` : p.name);

  const onCallText = onCall ? tag(onCall) : 'Nobody assigned, add someone in the dashboard';
  const others = people.filter((p) => p.upn !== onCall?.upn).map(tag);
  const mention = others.length ? `${onCallText} (also alerting ${others.join(', ')})` : onCallText;

  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', color, wrap: true },
      text && { type: 'TextBlock', text, wrap: true },
      facts.length && { type: 'FactSet', facts: facts.map(([t, v]) => ({ title: String(t), value: String(v) })) },
      { type: 'TextBlock', text: `On call: ${mention}`, wrap: true, spacing: 'Medium', weight: 'Bolder' },
    ].filter(Boolean),
    actions: process.env.DASHBOARD_URL ? [{ type: 'Action.OpenUrl', title: 'Open dashboard', url: process.env.DASHBOARD_URL }] : [],
  };
  if (dest.mention && people.length) {
    card.msteams = {
      entities: people.map((p) => ({ type: 'mention', text: `<at>${p.name}</at>`, mentioned: { id: p.upn, name: p.name } })),
    };
  }
  return JSON.stringify({
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }],
  });
}

async function send(url, payload, label) {
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: AbortSignal.timeout(10000) });
      if (r.ok) return { ok: true, status: r.status };
      last = `HTTP ${r.status}`;
      const body = await r.text();
      console.error(`[teams:${label}] attempt ${attempt} HTTP ${r.status}: ${body.slice(0, 300)}`);
      if (/WorkflowTriggerIsNotEnabled/.test(body)) last = 'The Teams workflow is switched off. Turn it on in Teams > Workflows.';
    } catch (e) {
      last = e.message;
      console.error(`[teams:${label}] attempt ${attempt} failed: ${e.message}`);
    }
  }
  return { ok: false, error: last };
}

// Decides which destinations receive this alert, from what was set up in the dashboard:
//   enabled, wants this kind of alert (down / up / daily / notice), covers the site(s), and the on-call rule matches.
function route(event, sites) {
  const onCallName = (getOnCall()?.name || '').toLowerCase();
  return getDestinations().filter((d) => {
    if (!d.enabled || !d.url || !d.events[event]) return false;
    if (d.onCallOnly && d.onCallOnly.toLowerCase() !== onCallName) return false;
    if (d.scope === 'sites' && sites && !sites.some((s) => d.sites.includes(s))) return false;
    return true;
  });
}

/**
 * Sends one alert to every matching destination.
 *   event: 'down' | 'up' | 'daily' | 'notice' | 'test'
 *   sites: names of the sites this alert is about (used for per-site routing); for 'daily' the facts are [siteName, issues] rows
 *   only:  a destination id, used by that destination's own test button (ignores all the rules above)
 */
async function postCard({ title, text, facts = [], color = 'Default' }, { event = 'test', sites = null, only = null } = {}) {
  const all = getDestinations();
  let targets;
  if (only) targets = all.filter((d) => d.id === only && d.url);
  else if (event === 'test') targets = all.filter((d) => d.enabled && d.url);
  else targets = route(event, sites);

  if (!targets.length) {
    console.warn(`[teams] no destination matches this alert (${event}), skipping:`, title);
    return { ok: false, reason: 'no destination', results: {} };
  }
  const results = {};
  await Promise.all(
    targets.map(async (d) => {
      // A destination limited to some sites only sees its own sites in a daily summary.
      let f = facts;
      if (event === 'daily' && d.scope === 'sites' && !only) f = facts.filter(([name]) => d.sites.includes(name));
      if (event === 'daily' && !only && d.scope === 'sites' && !f.length) return;
      const r = await send(d.url, buildCard({ title, text, facts: f, color }, d), d.name);
      results[d.id] = { name: d.name, ...r };
    })
  );
  const list = Object.values(results);
  if (!list.length) return { ok: false, reason: 'no destination', results };
  const ok = list.some((r) => r.ok);
  return { ok, results, error: ok ? undefined : list.map((r) => `${r.name}: ${r.error}`).join('; ') };
}

module.exports = { postCard };
