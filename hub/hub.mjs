// The hub's logic: look Sections up in DNS, verify signed statements (TIMDA-2),
// keep the registry, and render what the hub lists. Used by functions/ (Cloudflare
// Pages Functions) and by the tests. Everything external is passed in: `env.REGISTRY`
// (a KV namespace, or any object with get/put/list), `fetchImpl` and `now`.

import { CONFIG } from './config.mjs';
import { HOST_RE, LINKS, airlockUrl, fetchImage, lookupSection, sectionChecks } from './timda1.mjs';
import { verifySshsig } from './sshsig.mjs';
import { HOSTS, hostLine } from './hosts.mjs';

export const DEFAULT_HUB = 'timda.space';
const CHECK_TTL = 3600;        // reuse a record check for at most an hour (TIMDA-1 §8.2)...
const CHECK_MIN = 60;          // ...and at least a minute (KV's shortest expiry)
const DEFAULT_TTL = 300;       // when DNS gives no TTL at all (timda1.mjs uses the same)
const NONCE_TTL = 1200;        // remember nonces for 20 minutes (TIMDA-2 §7.5)
const FRESHNESS = 10 * 60;     // statements must be issued within 10 minutes (TIMDA-2 §7.4)
const MAX_STATEMENT = 4096;
const MAX_MESSAGE = 8192;     // a TIMDA-3 message may be bigger (TIMDA-3 §4.1)
/** The size limit for a statement of this type. */
export const sizeLimit = (type) => (type === 'message' ? MAX_MESSAGE : MAX_STATEMENT);
// Types that name the hub they're for, so they can't be replayed at another hub.
const HUB_BOUND = new Set(['dock-request', 'message', 'inbox', 'inbox-delete']);
export { HOST_RE, lookupSection }; // shared with the timda CLI, in timda1.mjs

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- buttons (TIMDA-1 §6.1) ---------------------------------------------------------

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
export const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Fetch a Section's button (or banner) and check it (timda1.mjs fetchImage), then
 * keep what the hub serves: { ok, type, width, height, data (base64), v (hash) }.
 */
async function fetchForHub(what, url, fetchImpl) {
  const r = await fetchImage(what, url, { fetchImpl });
  if (!r.ok) return r;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', r.bytes));
  const v = [...hash.subarray(0, 5)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { ok: true, type: r.type, width: r.width, height: r.height, data: toBase64(r.bytes), v };
}
export const fetchButton = (url, fetchImpl) => fetchForHub('button', url, fetchImpl);
export const fetchBanner = (url, fetchImpl) => fetchForHub('banner', url, fetchImpl);

// ---- the check cache ---------------------------------------------------------------
// Checks are cached at Cloudflare's edge (the Cache API: free, no daily cap) rather
// than in KV, whose free plan allows only 1,000 writes a day. Where there's no edge
// cache (tests, local runs) they fall back to KV. A pages.dev preview has a Cache API
// that never hits, so it just checks live every time.
const CACHE_ORIGIN = 'https://timda.space/__hub-cache/v1/check/';
const edgeCache = () => (typeof caches !== 'undefined' && caches.default) || null;

async function cacheGet(env, domain) {
  const c = edgeCache();
  if (c) { const r = await c.match(CACHE_ORIGIN + domain); return r ? r.json() : null; }
  return env.REGISTRY.get(`check:${domain}`, 'json');
}
async function cachePut(env, domain, result, ttl) {
  const c = edgeCache();
  if (c) {
    await c.put(CACHE_ORIGIN + domain, new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` } }));
  } else {
    await env.REGISTRY.put(`check:${domain}`, JSON.stringify(result), { expirationTtl: ttl });
  }
}
async function cacheDelete(env, domain) {
  const c = edgeCache();
  if (c) await c.delete(CACHE_ORIGIN + domain);
  await env.REGISTRY.delete?.(`check:${domain}`); // and any left from before the edge cache
}

/** A Section's current state (and its checked button), from a check no older than the records' TTL. */
export async function checkedSection(env, domain, opts = {}) {
  const cached = await cacheGet(env, domain);
  if (cached) return cached;
  let result;
  try {
    result = await lookupSection(domain, opts);
  } catch (e) {
    return { status: 'error', errors: [e.message], warnings: [] }; // don't cache lookup failures
  }
  if (result.status === 'valid' && result.section.button) result.button = await fetchButton(result.section.button, opts.fetchImpl);
  if (result.status === 'valid' && result.section.banner) result.banner = await fetchBanner(result.section.banner, opts.fetchImpl);
  await cachePut(env, domain, result, Math.min(CHECK_TTL, Math.max(CHECK_MIN, result.ttl ?? DEFAULT_TTL)));
  return result;
}

// ---- the registry ------------------------------------------------------------------

// The registry is one `section:<domain>` key per docked Section, plus an index key,
// `registry`: { domains (approved, listed), review (docked, waiting for the Board),
// delisted }. Pages read the index (a cheap get) instead of listing keys on every view
// (KV's free plan allows 1,000 lists a day). Only docking and the Board write it.
const INDEX = 'registry';

async function listRegistry(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.REGISTRY.list({ prefix: 'section:', cursor });
    out.push(...page.keys.map((k) => k.name.slice('section:'.length)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort();
}

/** The registry index, rebuilt from the section: keys if it's missing. */
export async function readIndex(env) {
  const index = await env.REGISTRY.get(INDEX, 'json');
  if (Array.isArray(index?.domains)) return { domains: index.domains, review: index.review ?? [], delisted: index.delisted ?? [] };
  const built = { domains: [], review: [], delisted: [] };
  for (const d of await listRegistry(env)) {
    const rec = await env.REGISTRY.get(`section:${d}`, 'json');
    // Sections docked before reviews existed (no state) count as approved.
    built[rec?.state === 'review' ? 'review' : rec?.state === 'delisted' ? 'delisted' : 'domains'].push(d);
  }
  await env.REGISTRY.put(INDEX, JSON.stringify(built));
  return built;
}

async function moveTo(env, index, domain, list, record) {
  const next = { domains: index.domains.filter((d) => d !== domain), review: index.review.filter((d) => d !== domain), delisted: index.delisted.filter((d) => d !== domain) };
  next[list] = [...next[list], domain].sort();
  await env.REGISTRY.put(INDEX, JSON.stringify(next));
  await env.REGISTRY.put(`section:${domain}`, JSON.stringify(record));
  await cacheDelete(env, domain);
  return next;
}

/** Approved Sections: the only ones the hub lists, routes to, or shows anything of. */
export async function registeredDomains(env) {
  return (await readIndex(env)).domains;
}

/** Sections the hub lists: approved by the Board, valid and unexpired. Pending ones are
 *  listed greyed out; only open ones are routed to (randomTarget / nextTarget). */
export async function listedSections(env, opts = {}) {
  const domains = await registeredDomains(env);
  const checks = await Promise.all(domains.map((d) => checkedSection(env, d, opts)));
  return domains
    .map((domain, i) => ({ domain, ...checks[i] }))
    .filter((s) => s.status === 'valid');
}

// ---- the arrivals board: public announcements -----------------------------------------

// One KV key, `announcements`: { seen: { <domain>: { status, name } }, events: [...] },
// newest first, the last 50. It's written only when something changed, and it's
// worked out when someone looks (the Arrivals page or the feed): Pages has no cron, and
// if nobody's looking there's nobody to tell. Only approved Sections ever appear.
const ANNOUNCEMENTS = 'announcements';

/**
 * Approved Sections, checked, plus the arrivals board brought up to date: arrived,
 * returned, status (open/closed/pending) and left. A failed lookup changes nothing, so
 * a DNS hiccup never reads as a departure. Returns { listed, events }.
 */
export async function announce(env, opts = {}) {
  const domains = await registeredDomains(env);
  const checks = await Promise.all(domains.map((d) => checkedSection(env, d, opts)));
  const listed = domains.map((domain, i) => ({ domain, ...checks[i] })).filter((s) => s.status === 'valid');
  const log = (await env.REGISTRY.get(ANNOUNCEMENTS, 'json')) ?? { seen: {}, events: [] };
  const seen = { ...log.seen };
  const fresh = [];
  const now = (opts.now ?? new Date()).toISOString();
  const add = (e) => {
    const last = log.events.find((x) => x.domain === e.domain);
    if (last && last.kind === e.kind && last.status === e.status) return; // another request beat us to it
    fresh.push(e);
  };

  for (const [i, domain] of domains.entries()) {
    const c = checks[i];
    if (c.status === 'error') continue;
    const was = seen[domain];
    if (c.status !== 'valid') {
      if (was && was.status !== 'gone') { add({ at: now, domain, kind: 'left', name: was.name }); seen[domain] = { ...was, status: 'gone' }; }
      continue;
    }
    const s = c.section;
    const e = { domain, name: s.name, status: s.status, ...(s.concept && { concept: s.concept }), airlock: airlockUrl(domain, s) };
    if (!was) {
      // when the Board approved it; for Sections docked before reviews, when it docked
      const rec = await env.REGISTRY.get(`section:${domain}`, 'json');
      add({ at: rec?.reinstated ?? rec?.approved ?? rec?.docked ?? now, kind: 'arrived', ...e });
    } else if (was.status === 'gone') add({ at: now, kind: 'returned', ...e });
    else if (was.status !== s.status) add({ at: now, kind: 'status', ...e });
    seen[domain] = { status: s.status, name: s.name };
  }
  // Delisted, or otherwise no longer approved: gone, as far as anyone here can tell.
  for (const [domain, was] of Object.entries(seen)) {
    if (!domains.includes(domain) && was.status !== 'gone') { add({ at: now, domain, kind: 'left', name: was.name }); seen[domain] = { ...was, status: 'gone' }; }
  }

  let events = log.events;
  if (fresh.length) {
    events = [...fresh, ...log.events].sort((x, y) => y.at.localeCompare(x.at)).slice(0, CONFIG.arrivalsBoard.kept);
    const kept = new Set(events.map((x) => x.domain));
    // forget gone Sections once their last announcement scrolls off the board
    for (const [d, v] of Object.entries(seen)) if (v.status === 'gone' && !kept.has(d)) delete seen[d];
    await env.REGISTRY.put(ANNOUNCEMENTS, JSON.stringify({ seen, events }));
  }
  return { listed, events };
}

const REMARKS = { arrived: 'Docked', returned: 'Returned', left: 'Undocked' };
/** What the board says about an event: "Docked", "Now open", … */
export const remark = (e) => REMARKS[e.kind] ?? `Now ${e.status}`;

/** The Arrivals page's board: the latest few, as a table. */
export function renderAnnouncements(events, count = CONFIG.arrivalsBoard.shown) {
  if (!events.length) return '<p class="empty">No arrivals yet. The concourse is quiet.</p>';
  const rows = events.slice(0, count).map((e) => {
    const name = e.kind !== 'left' && e.status === 'open' ? `<a href="${esc(e.airlock)}">${esc(e.name)}</a>` : esc(e.name);
    const cls = e.kind === 'left' ? 'gone' : `status-${e.status}`;
    return `<tr><td><time datetime="${esc(e.at)}">${esc(e.at.slice(0, 10))}</time></td><td>${name}</td><td class="${esc(cls)}">${esc(remark(e))}</td></tr>`;
  });
  return `<table class="flightboard"><thead><tr><th scope="col">Date</th><th scope="col">Section</th><th scope="col">Remarks</th></tr></thead><tbody>\n${rows.join('\n')}\n</tbody></table>`;
}

/** The arrivals board as an Atom feed (RFC 4287). */
export function renderFeed(events, origin) {
  const updated = events[0]?.at ?? '2026-11-22T00:00:00.000Z';
  const host = new URL(origin).host;
  const entries = events.map((e) => {
    const title = e.kind === 'status' ? `${e.name} is now ${e.status}` : `${e.name}: ${remark(e).toLowerCase()}`;
    const link = e.kind !== 'left' && e.status === 'open' ? e.airlock : `${origin}/hypermall`;
    const summary = [e.domain, e.concept].filter(Boolean).join(': ');
    return [
      '  <entry>',
      `    <id>tag:${esc(host)},2026:${esc(e.domain)}/${esc(e.kind)}/${esc(e.at)}</id>`,
      `    <title>${esc(title)}</title>`,
      `    <updated>${esc(e.at)}</updated>`,
      `    <link href="${esc(link)}"/>`,
      `    <summary>${esc(summary)}</summary>`,
      '  </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>TIMDA arrivals board</title>',
    '  <subtitle>Sections docking at, changing status on, and leaving the station.</subtitle>',
    `  <id>${esc(origin)}/feed</id>`,
    `  <link rel="self" href="${esc(origin)}/feed"/>`,
    `  <link href="${esc(origin)}/"/>`,
    `  <updated>${esc(updated)}</updated>`,
    '  <author><name>Technocratic Incorporated</name></author>',
    `  <icon>${esc(origin)}/favicon.svg</icon>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}

// ---- TIMDA-2 statements -------------------------------------------------------------

/** Parse a statement's headers (TIMDA-2 §4). Throws with a readable message. */
export function parseStatement(text) {
  const [head, ...bodyParts] = text.split('\n\n');
  const lines = head.replace(/\n+$/, '').split('\n'); // a statement with no body ends in a newline
  const headers = new Map();
  for (const line of lines) {
    const m = /^([a-z0-9-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!m) throw new Error(`malformed header line: ${JSON.stringify(line.slice(0, 60))}`);
    if (headers.has(m[1])) throw new Error(`duplicate header: ${m[1]}`);
    headers.set(m[1], m[2]);
  }
  if (lines[0] !== 'timda-statement: 1' && !/^timda-statement:\s*1$/.test(lines[0])) {
    throw new Error('the first line must be "timda-statement: 1"');
  }
  for (const h of ['type', 'from', 'issued', 'nonce']) if (!headers.get(h)) throw new Error(`missing header: ${h}`);
  const from = headers.get('from');
  if (!HOST_RE.test(from)) throw new Error('from: must be a lowercase domain name with no trailing dot');
  const issued = headers.get('issued');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(issued) || Number.isNaN(Date.parse(issued))) {
    throw new Error('issued: must be RFC 3339 UTC, like 2026-11-22T06:45:00Z');
  }
  const nonce = headers.get('nonce');
  if (!/^[A-Za-z0-9_-]{22,}$/.test(nonce) && !/^[0-9a-f]{32,}$/i.test(nonce)) {
    throw new Error('nonce: needs at least 128 random bits (22+ base64url or 32+ hex characters)');
  }
  return { headers, body: bodyParts.join('\n\n') };
}

/**
 * Check a signed statement end to end (TIMDA-2 §7). `message` is the exact bytes that
 * were signed. Returns { ok: true, from, type, section } or { ok: false, error }.
 */
export async function verifyStatement(env, { message, armored, hub = DEFAULT_HUB, fetchImpl = fetch, now = new Date() }) {
  if (message.length > MAX_MESSAGE) return { ok: false, error: `statement is over ${MAX_MESSAGE} bytes` };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(message); } catch { return { ok: false, error: 'statement is not UTF-8' }; }

  let st;
  try { st = parseStatement(text); } catch (e) { return { ok: false, error: e.message }; }
  const from = st.headers.get('from');
  const type = st.headers.get('type');
  if (message.length > sizeLimit(type)) return { ok: false, error: `a ${type} statement is at most ${sizeLimit(type)} bytes` };

  // Live records, never cached here: keys must come straight from DNS (TIMDA-1 §9.1).
  let looked;
  try { looked = await lookupSection(from, { fetchImpl, now }); } catch (e) { return { ok: false, error: e.message }; }
  if (looked.status === 'none') return { ok: false, error: `${from} has no _timda records` };
  if (looked.status !== 'valid') return { ok: false, error: `${from}'s records are ${looked.status}: ${looked.errors.join('; ')}` };

  const sig = await verifySshsig({ message, armored, namespace: 'timda', allowedKeys: looked.section.key });
  if (!sig.ok) return { ok: false, error: sig.error };

  if (type !== 'announcement') {
    const skew = Math.abs(now.getTime() - Date.parse(st.headers.get('issued'))) / 1000;
    if (skew > FRESHNESS) return { ok: false, error: `issued is ${Math.round(skew / 60)} minutes from now; sign a fresh statement (it must be within 10 minutes)` };
  }
  if ((HUB_BOUND.has(type) || type.startsWith('board-')) && st.headers.get('hub') !== hub) {
    return { ok: false, error: `hub: must be ${hub}` };
  }
  // Last, so a statement that fails any other check can be fixed and resent.
  const nonceKey = `nonce:${from}:${st.headers.get('nonce')}`;
  if (await env.REGISTRY.get(nonceKey)) return { ok: false, error: 'this statement was already used (repeated nonce); sign a fresh one' };
  await env.REGISTRY.put(nonceKey, '1', { expirationTtl: NONCE_TTL });
  return { ok: true, from, type, section: looked.section, headers: st.headers, body: st.body };
}

/**
 * Handle a dock request: verify it, then add the Section to the registry. A new Section
 * waits for the Board's review (state 'review'); an approved one is just re-checked; a
 * delisted one is refused.
 */
export async function dock(env, args) {
  const v = await verifyStatement(env, args);
  if (!v.ok) return v;
  if (v.type !== 'dock-request') return { ok: false, error: `this endpoint takes dock-request statements, not ${v.type}` };
  const index = await readIndex(env);
  if (index.delisted.includes(v.from)) return { ok: false, error: `this hub has delisted ${v.from}` };
  const key = `section:${v.from}`;
  const existing = await env.REGISTRY.get(key, 'json');
  const docked = existing?.docked ?? args.now?.toISOString?.() ?? new Date().toISOString();
  if (index.domains.includes(v.from)) {
    await cacheDelete(env, v.from); // list it from fresh records
    return { ...v, already: true, state: 'approved' };
  }
  if (!CONFIG.docking.review) { // an open hub: list it now
    await moveTo(env, index, v.from, 'domains', { docked, state: 'approved', approved: docked });
    return { ...v, already: false, state: 'approved' };
  }
  if (!index.review.includes(v.from)) await moveTo(env, index, v.from, 'review', { docked, state: 'review' });
  return { ...v, already: index.review.includes(v.from), state: 'review' };
}

// ---- the Board: moderation, signed with the hub's own keys ------------------------

const BOARD = ['board-agenda', 'board-approve', 'board-delist', 'board-reinstate'];

/**
 * A Board resolution: a statement signed with a key from the hub's own _key._timda
 * records. board-agenda lists what's waiting; approve, delist and reinstate name the
 * Section in a `section:` header (delist may give a `reason:`).
 */
export async function board(env, args) {
  const hub = args.hub ?? DEFAULT_HUB;
  const v = await verifyStatement(env, args);
  if (!v.ok) return v;
  if (!BOARD.includes(v.type)) return { ok: false, error: `this endpoint takes Board resolutions (${BOARD.join(', ')}), not ${v.type}` };
  if (v.from !== hub) return { ok: false, error: `only ${hub}'s own keys can sign Board resolutions` };
  const index = await readIndex(env);
  if (v.type === 'board-agenda') return { ok: true, type: v.type, index };

  const st = parseStatement(new TextDecoder().decode(args.message));
  const target = (st.headers.get('section') ?? '').toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(target)) return { ok: false, error: 'section: must name a domain' };
  const record = (await env.REGISTRY.get(`section:${target}`, 'json')) ?? {};
  const at = (args.now ?? new Date()).toISOString();
  if (v.type === 'board-approve') {
    if (index.delisted.includes(target)) return { ok: false, error: `${target} is delisted; reinstate it instead` };
    if (!index.review.includes(target)) return { ok: false, error: index.domains.includes(target) ? `${target} is already approved` : `${target} hasn't asked to dock` };
    await moveTo(env, index, target, 'domains', { ...record, state: 'approved', approved: at });
  } else if (v.type === 'board-delist') {
    if (index.delisted.includes(target)) return { ok: false, error: `${target} is already delisted` };
    await moveTo(env, index, target, 'delisted', { ...record, state: 'delisted', delisted: at, reason: st.headers.get('reason') ?? undefined });
  } else {
    if (!index.delisted.includes(target)) return { ok: false, error: `${target} isn't delisted` };
    await moveTo(env, index, target, 'domains', { ...record, state: 'approved', reinstated: at, reason: undefined });
  }
  return { ok: true, type: v.type, target };
}

// ---- the mast: beacon and signal tests --------------------------------------------

/** GOOD / WARN / CRIT checks for a looked-up Section: timda1.mjs sectionChecks, as `timda finger` prints them. */
export const beaconChecks = (result, button, banner) =>
  sectionChecks(result, { images: { ...(button && { button }), ...(banner && { banner }) } });

/** Listen for a domain's beacon: a live lookup (never cached) and its button. */
export async function beacon(domain, { fetchImpl = fetch, now = new Date() } = {}) {
  let result;
  try { result = await lookupSection(domain, { fetchImpl, now }); } catch (e) { result = { status: 'error', errors: [e.message], warnings: [] }; }
  const valid = result.status === 'valid';
  const button = valid && result.section.button ? await fetchButton(result.section.button, fetchImpl) : undefined;
  const banner = valid && result.section.banner ? await fetchBanner(result.section.banner, fetchImpl) : undefined;
  return { result, button, banner, checks: beaconChecks(result, button, banner) };
}

/**
 * Check a signed statement against its Section's live keys, and say what a hub would
 * make of it. Only looks: nothing is docked, and the nonce isn't used up.
 */
export async function signalChecks({ message, armored, hub = DEFAULT_HUB, fetchImpl = fetch, now = new Date() }) {
  const out = [];
  const add = (level, text) => out.push([level, text]);
  if (message.length > MAX_MESSAGE) { add('CRIT', `statement is over ${MAX_MESSAGE} bytes`); return out; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(message); } catch { add('CRIT', 'statement is not UTF-8'); return out; }
  let st;
  try { st = parseStatement(text); } catch (e) { add('CRIT', e.message); return out; }
  const from = st.headers.get('from');
  const type = st.headers.get('type');
  add('GOOD', `statement parses: type ${type}, from ${from}`);
  if (message.length > sizeLimit(type)) add('CRIT', `a ${type} statement is at most ${sizeLimit(type)} bytes`);

  let looked;
  try { looked = await lookupSection(from, { fetchImpl, now }); } catch (e) { add('CRIT', e.message); return out; }
  if (looked.status === 'none') { add('CRIT', `${from} has no _timda records`); return out; }
  if (looked.status !== 'valid') { add('CRIT', `${from}'s records are ${looked.status}: ${looked.errors.join('; ')}`); return out; }

  const sig = await verifySshsig({ message, armored, namespace: 'timda', allowedKeys: looked.section.key });
  if (!sig.ok) { add('CRIT', sig.error); return out; }
  add('GOOD', `signature verifies with ${sig.key}, published at _key._timda.${from}`);

  const skew = Math.abs(now.getTime() - Date.parse(st.headers.get('issued'))) / 1000;
  if (type === 'announcement') add('GOOD', 'announcements never go stale');
  else if (skew <= FRESHNESS) add('GOOD', 'issued within 10 minutes: a hub would accept it now');
  else add('WARN', `issued ${Math.round(skew / 60)} minutes from now; a hub wants one signed within 10 minutes`);
  if ((HUB_BOUND.has(type) || type.startsWith('board-')) && st.headers.get('hub') !== hub) add('WARN', `hub: is ${st.headers.get('hub') ?? 'missing'}; this hub wants ${hub}`);
  return out;
}

// ---- rendering ---------------------------------------------------------------------

const STATUS_ORDER = { open: 0, closed: 1, pending: 2 };

/** The worst level among some checks: 'crit', 'warn' or 'good'. */
export const worstLevel = (checks) => (checks.some(([l]) => l === 'CRIT') ? 'crit' : checks.some(([l]) => l === 'WARN') ? 'warn' : 'good');

/** A list of GOOD / WARN / CRIT checks, as HTML, with the checked button and banner if there are any. */
export function renderChecks(title, checks, button, banner) {
  const items = checks.map(([level, text]) => `<li><span class="level level-${level.toLowerCase()}">${level}</span> ${esc(text)}</li>`);
  // Only ever a button that passed checkButtonImage: a PNG or GIF of the right size.
  const img = button?.data
    ? `<figure class="sstv"><div class="sstv-screen"><img src="data:${esc(button.type)};base64,${esc(button.data)}" width="176" height="62" alt="The Section's 88x31 button"></div><figcaption>SSTV RX &middot; 88&times;31 &middot; Martin M1 &middot; ${button.width === 176 ? 'hi-res' : 'lo-res'}</figcaption></figure>`
    : '';
  const wide = banner?.data
    ? `<figure class="sstv sstv-wide"><div class="sstv-screen"><img src="data:${esc(banner.type)};base64,${esc(banner.data)}" width="468" height="60" alt="The Section's banner"></div><figcaption>SSTV RX &middot; 468&times;60 &middot; Martin M1</figcaption></figure>`
    : '';
  return `<div class="checks" role="status"><p class="checks-title">${title}</p>${img}${wide}<ul>\n${items.join('\n')}\n</ul></div>`;
}

/** The record values a beacon heard, as a definition list (all escaped). Links on the
 *  Section's own domain show just their path, under the domain listed once. */
export function renderRecords(section, domain) {
  if (!section) return '';
  const short = (url) => {
    try { const u = new URL(url); return u.hostname === domain ? `${u.pathname}${u.search}` : url; } catch { return url; }
  };
  const rows = [
    ['Domain', domain],
    ['Name', section.name], ['Type', section.type], ['Status', section.status],
    ['Concept', section.concept], ['Expires', section.expires],
    ...section.key.map((k) => ['Key', k]),
    ...LINKS.filter((p) => section[p]).map((p) => [p[0].toUpperCase() + p.slice(1), short(section[p])]),
    ['Caption', section.caption],
  ].filter(([, v]) => v);
  // Keys are long: show them shortened; tap to open the whole value in a field that's
  // easy to select and copy (no JavaScript, so no copy button).
  const cell = (k, v) => {
    if (k !== 'Key') return esc(v);
    const [alg, b64] = v.split(':');
    return `<details class="keyval"><summary><code>${esc(alg)}:${esc(b64.slice(0, 6))}&hellip;${esc(b64.slice(-6))}</code></summary>`
      + `<input type="text" readonly value="${esc(v)}" aria-label="Full key, to copy" spellcheck="false"></details>`;
  };
  return `<dl class="heard-records">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${cell(k, v)}</dd></div>`).join('')}</dl>`;
}

/** The HyperMall's storefronts, as HTML. All record content is escaped. */
export function renderStorefronts(listed) {
  if (!listed.length) return '<p class="empty">No Sections are docked yet. Units available.</p>';
  const items = [...listed]
    .sort((a, b) => STATUS_ORDER[a.section.status] - STATUS_ORDER[b.section.status] || a.section.name.localeCompare(b.section.name))
    .map(({ domain, section: s, button }) => {
      const open = s.status === 'open';
      const name = open
        ? `<a class="name" href="${esc(airlockUrl(domain, s))}">${esc(s.name)}</a>`
        : `<span class="name">${esc(s.name)}</span>`;
      // The hub's own copy of the button (TIMDA-1 §6.1); never the Section's URL.
      const img = button?.data
        ? `<img src="/buttons/${esc(domain)}?v=${esc(button.v)}" width="88" height="31" alt="${open ? esc(s.name) : ''}">`
        : '';
      const btn = img ? (open ? `<a class="button88" href="${esc(airlockUrl(domain, s))}" tabindex="-1">${img}</a>` : `<span class="button88">${img}</span>`) : '';
      const links = [
        s.charter ? `<a href="${esc(s.charter)}">Charter</a>` : '',
        s.setting ? `<a href="${esc(s.setting)}">Setting</a>` : '',
      ].filter(Boolean).join(' · ');
      return [
        `<li class="storefront storefront-${esc(s.status)}">`,
        `<span class="status status-${esc(s.status)}">${esc(s.status)}</span> `,
        name,
        ` <span class="domain">${esc(domain)}</span>`,
        s.concept ? `<span class="concept">${esc(s.concept)}</span>` : '',
        links ? `<span class="links">${links}</span>` : '',
        btn,
        `</li>`,
      ].join('');
    });
  return `<ol class="storefronts">\n${items.join('\n')}\n</ol>`;
}

/** Replace the content between <!-- name:start --> and <!-- name:end --> markers. */
export function fill(html, name, content) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < a) return html;
  return html.slice(0, a + start.length) + content + html.slice(b);
}

// ---- the Observation Lounge's showcase ----------------------------------------------

/** Open Sections with a checked banner. */
export const showcaseSections = (listed) => listed.filter((s) => s.section.status === 'open' && s.banner?.data);

/** One banner for the Lounge, as HTML: the held one if asked, else at random, with a
 *  random host to introduce it. */
export function renderShowcase(listed, { hold, rotate = false, rand = Math.random, hostRand = Math.random } = {}) {
  const all = showcaseSections(listed);
  if (!all.length) {
    return '<p class="showcase-empty">The AuthentiGlass is clear. No Section is showing a banner yet. <a href="/dock#your-banner">Advertise here!</a></p>';
  }
  const held = all.find((s) => s.domain === hold);
  const pick = held ?? all[Math.floor(rand() * all.length)];
  const holding = Boolean(held) && all.length > 1;
  const { domain, section: s, banner, button } = pick;
  const airlock = airlockUrl(domain, s);
  const host = HOSTS[Math.floor(hostRand() * HOSTS.length)];
  const line = hostLine(host, { name: `<strong>${esc(s.name)}</strong>`, caption: s.caption ? esc(s.caption) : undefined }, hostRand);
  return [
    '<figure class="showcase">',
    `<a class="showcase-banner" href="${esc(airlock)}"><img src="/banners/${esc(domain)}?v=${esc(banner.v)}" width="468" height="60" alt="${esc(s.name)}"></a>`,
    '<figcaption>',
    `<div class="host host-${host.id}">${host.portrait}<div class="bubble"><p class="host-name">${esc(host.name)} <span>${esc(host.role)}</span></p><p>${line}</p></div></div>`,
    `<p class="showcase-from"><a href="${esc(airlock)}">${esc(s.name)}</a> <span class="domain">${esc(domain)}</span>${s.setting ? ` &middot; <a href="${esc(s.setting)}">Setting</a>` : ''}</p>`,
    button?.data ? `<p class="showcase-button"><a href="${esc(airlock)}" tabindex="-1"><img src="/buttons/${esc(domain)}?v=${esc(button.v)}" width="88" height="31" alt="${esc(s.name)}"></a></p>` : '',
    '</figcaption>',
    '</figure>',
    // Controls only mean something when there's more than one banner. The page never
    // reloads itself unless asked (?rotate): a reload starts a screen reader over.
    all.length < 2 ? '<p class="showcase-controls">One great idea so far. More on the way as Sections hang their banners. <a href="/dock#your-banner">Advertise here!</a></p>'
      : holding ? '<p class="showcase-controls">Held. <a href="/lounge?rotate">Rotate every minute</a> &middot; <a href="/lounge">Next great idea</a></p>'
        : rotate ? `<p class="showcase-controls">Next great idea in a minute. <a href="/lounge?hold=${encodeURIComponent(domain)}">Hold this view</a> &middot; <a href="/lounge">Stop rotating</a></p>`
          : '<p class="showcase-controls"><a href="/lounge">Next great idea</a> &middot; <a href="/lounge?rotate">Rotate every minute</a></p>',
  ].join('\n');
}

// ---- webring jumps -----------------------------------------------------------------

/** Where *random* goes: a random open Section's airlock, or null. */
export function randomTarget(listed, rand = Math.random) {
  const open = listed.filter((s) => s.section.status === 'open');
  if (!open.length) return null;
  const pick = open[Math.floor(rand() * open.length)];
  return airlockUrl(pick.domain, pick.section);
}

/** Where *next* goes from `from`: the next open Section by domain, wrapping round. */
export function nextTarget(listed, from) {
  const open = listed.filter((s) => s.section.status === 'open').sort((a, b) => a.domain.localeCompare(b.domain));
  if (!open.length) return null;
  const after = open.find((s) => from && s.domain.localeCompare(from) > 0) ?? open[0];
  return airlockUrl(after.domain, after.section);
}

export { LINKS };
