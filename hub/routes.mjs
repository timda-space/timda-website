// Request handlers for the hub's dynamic routes. functions/* are thin wrappers, so
// these can be tested in Node with stand-ins for KV, static assets and DNS.

import { DEFAULT_HUB, HOST_RE, announce, beacon, board, checkedSection, dock, esc, registeredDomains, fill, renderAnnouncements, renderFeed, fromBase64, listedSections, nextTarget, randomTarget, renderChecks, renderRecords, renderShowcase, renderStorefronts, showcaseSections, signalChecks, worstLevel } from './hub.mjs';
import { airlockUrl } from './timda1.mjs';
import { CONFIG } from './config.mjs';
import { relay, renderRelay } from './post.mjs';
import { planFromValues, plannerValues, renderPlanFormats, renderPlannerForm } from './planner.mjs';

// Function responses carry the same security headers as public/_headers.
export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=86400',
};

function htmlResponse(html, status = 200, extra = {}) {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra } });
}
// The beacon test shows the button it checked inline, so its page allows data: images.
const BEACON_CSP = { 'content-security-policy': SECURITY_HEADERS['content-security-policy'].replace("img-src 'self'", "img-src 'self' data:") };
function redirect(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...SECURITY_HEADERS } });
}
// Programs (the timda CLI) ask for JSON with Accept: application/json; people get the page.
const wantsJson = (request) => (request.headers.get('accept') ?? '').includes('application/json');
const jsonResponse = (status, body) => new Response(`${JSON.stringify(body, null, 2)}\n`, {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
});
const notice = (kind, html) => `<div class="notice notice-${kind}" role="status">${html}</div>`;

/** A static page with a live part filled in; falls back to the static page as-is. */
async function withLive({ next, env }, fillIn) {
  const res = await next();
  if (!env.REGISTRY || !res.ok) return res;
  try {
    return htmlResponse(await fillIn(await res.text()), res.status);
  } catch {
    return res; // a DNS hiccup shouldn't take the page down
  }
}

// GET /hypermall: the storefronts, live.
export const hypermall = (ctx, deps = {}) => withLive(ctx, async (html) =>
  fill(html, 'storefronts', renderStorefronts(await listedSections(ctx.env, deps))));

// GET /lounge: the Observation Lounge's showcase, one opt-in banner at a time. It
// rotates with a plain Refresh header (no JavaScript); ?hold=<domain> stops it.
export async function lounge(ctx, deps = {}) {
  const res = await ctx.next();
  if (!ctx.env.REGISTRY || !res.ok) return res;
  try {
    const listed = await listedSections(ctx.env, deps);
    const showing = showcaseSections(listed);
    const params = new URL(ctx.request.url).searchParams;
    const asked = params.get('hold') ?? undefined;
    const hold = showing.some((s) => s.domain === asked) ? asked : undefined; // an unknown hold is ignored
    // Rotation is opt-in (?rotate): a page that reloads itself loses a screen reader's place.
    const rotate = params.has('rotate') && !hold && showing.length > 1;
    const html = fill(await res.text(), 'showcase', renderShowcase(listed, { hold, rotate, rand: deps.rand }));
    return htmlResponse(html, 200, rotate ? { refresh: String(CONFIG.lounge.rotateSeconds) } : {});
  } catch {
    return res;
  }
}

// GET /: the station status's "Sections docked", live.
export const arrivals = (ctx, deps = {}) => withLive(ctx, async (html) => {
  const { listed, events } = await announce(ctx.env, deps);
  return fill(fill(html, 'docked', String(listed.length)), 'announcements', renderAnnouncements(events));
});

// GET /feed: the arrivals board as Atom.
export async function feed({ request, env }, deps = {}) {
  const origin = new URL(request.url).origin;
  let events = [];
  if (env.REGISTRY) {
    try { ({ events } = await announce(env, deps)); } catch { /* an empty feed beats an error */ }
  }
  return new Response(renderFeed(events, origin), {
    headers: { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=300', ...SECURITY_HEADERS },
  });
}

// GET /random and /next?from=<domain>: webring jumps to an open Section's airlock.
async function jump(ctx, deps, pick) {
  const fallback = new URL('/hypermall', ctx.request.url).href;
  if (!ctx.env.REGISTRY) return redirect(fallback);
  try {
    return redirect(pick(await listedSections(ctx.env, deps)) ?? fallback);
  } catch {
    return redirect(fallback);
  }
}
export const random = (ctx, deps = {}) => jump(ctx, deps, (listed) => randomTarget(listed, deps.rand));
export const next = (ctx, deps = {}) => {
  const from = (new URL(ctx.request.url).searchParams.get('from') ?? '').toLowerCase().replace(/\.$/, '');
  return jump(ctx, deps, (listed) => nextTarget(listed, from));
};

// Every HTML page, on any host but the live one: a STAGING (or PREVIEW) badge, and
// noindex so search engines leave the test copies alone. The same files deploy to
// both, so this has to come from the hostname, not the build. (_middleware.js)
export const PRODUCTION_HOST = DEFAULT_HUB;
const BADGE = (label, live) => `<div class="env-badge" role="note">${label}<span> &middot; not the live station</span> <a class="resync" href="${esc(live)}">Resynchronize</a></div>`;

/** The same page on the live station: same path for a GET; for a form reply, the page (or home, for /api/). */
function liveUrl(request, host) {
  const u = new URL(request.url);
  const path = request.method === 'GET' ? u.pathname + u.search : u.pathname.startsWith('/api/') ? '/' : u.pathname;
  return `https://${host}${path}`;
}


// Cloudflare can inject its own scripts (Web Analytics, and others) into HTML on the
// way out. 'no-transform' tells it not to touch the page, whatever is switched on in
// the dashboard: these sites promise no JavaScript and no analytics.
function noTransform(res) {
  if (!(res.headers.get('content-type') ?? '').startsWith('text/html')) return res;
  const cc = res.headers.get('cache-control');
  if (cc && /\bno-transform\b/.test(cc)) return res;
  const out = new Response(res.body, res);
  out.headers.set('cache-control', cc ? `${cc}, no-transform` : 'no-transform');
  return out;
}

export const envBadge = async (ctx) => noTransform(await envBadgeInner(ctx));

async function envBadgeInner({ request, next }) {
  // Collapse repeated slashes (//hypermall -> /hypermall), so odd spellings of a
  // path get the same answer as the real one, a 404 included.
  const url = new URL(request.url);
  if (url.pathname.includes('//')) {
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    return new Response(null, { status: 308, headers: { location: url.pathname + url.search, ...SECURITY_HEADERS } });
  }
  const host = url.hostname;
  if (host === PRODUCTION_HOST) return next();
  // Ask for the whole page, never "304 Not Modified": a browser may have cached it
  // without the badge, and a 304 can't carry the rewritten body anyway.
  const fresh = new Request(request);
  fresh.headers.delete('if-none-match');
  fresh.headers.delete('if-modified-since');
  const res = await next(fresh);
  const out = new Response(res.body, res); // headers are mutable on the copy
  out.headers.set('x-robots-tag', 'noindex, nofollow');
  const isHtml = (res.headers.get('content-type') ?? '').startsWith('text/html');
  if (!['GET', 'POST'].includes(request.method) || !res.body || res.status === 304 || !isHtml) return out;
  const label = host.startsWith('staging.') ? 'Staging' : 'Preview';
  const html = (await out.text()).replace(/<body[^>]*>/, (m) => `${m}\n${BADGE(label, liveUrl(request, PRODUCTION_HOST))}`);
  const headers = new Headers(out.headers);
  headers.delete('content-length');
  headers.delete('etag'); // the bytes differ from the asset's
  return new Response(html, { status: out.status, statusText: out.statusText, headers });
}

// GET /buttons/<domain> and /banners/<domain>: the hub's checked copy of a docked
// Section's button or banner. Only for Sections in the registry, so the hub can't be
// used to fetch arbitrary URLs.
const image = (kind) => async ({ env, params }, deps = {}) => {
  const notFound = () => new Response(`No ${kind} here.\n`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
  const domain = String(params?.domain ?? '').toLowerCase();
  if (!env.REGISTRY || !(await registeredDomains(env)).includes(domain)) return notFound(); // approved Sections only
  const c = await checkedSection(env, domain, deps);
  const img = c[kind];
  if (c.status !== 'valid' || !img?.data) return notFound();
  return new Response(fromBase64(img.data), {
    headers: {
      'content-type': img.type,
      'cache-control': 'public, max-age=3600',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
};
export const button = image('button');
export const banner = image('banner');

/** A signed statement and its signature from a form, as uploaded files or pasted text. */
async function readSigned(request) {
  let form;
  try { form = await request.formData(); } catch { return { error: 'Send the statement and signature with the form below.' }; }
  const read = async (field) => {
    const v = form.get(field);
    if (v && typeof v === 'object' && 'arrayBuffer' in v) return new Uint8Array(await v.arrayBuffer());
    return typeof v === 'string' && v.trim() ? v : null;
  };
  let message = await read('statement');
  let sig = await read('signature');
  if (!message || !sig) return { error: 'Both the statement and its signature are needed.' };
  if (typeof message === 'string') {
    // Pasted text: browsers send line breaks as CRLF. ssh-keygen signed LF, ending in a newline.
    message = new TextEncoder().encode(message.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n'));
  }
  if (typeof sig !== 'string') sig = new TextDecoder().decode(sig);
  return { message, armored: sig };
}

// GET /econopod?domain=<d>: the mast's beacon test, a live check of a domain's records.
export async function econopod({ request, next }, deps = {}) {
  const res = await next();
  if (!res.ok) return res;
  const raw = new URL(request.url).searchParams.get('domain');
  const html = fill(await res.text(), 'planner-form', renderPlannerForm());
  if (raw === null) return htmlResponse(html);
  const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/].*$/, '').replace(/\.$/, '');
  if (!HOST_RE.test(domain)) {
    const why = raw.trim() ? `not a domain name: ${raw.slice(0, 80)}` : 'enter a domain name, like section72.net';
    return htmlResponse(fill(html, 'beacon', renderChecks('No beacon', [['CRIT', why]])), 400);
  }
  const { result, checks, button, banner } = await beacon(domain, { fetchImpl: deps.fetchImpl ?? fetch, now: deps.now ?? new Date() });
  const title = `Beacon: <span class="heard heard-${worstLevel(checks)}">${esc(domain)}</span>`;
  return htmlResponse(fill(html, 'beacon', renderChecks(title, checks, button, banner) + renderRecords(result.section, domain)), 200, BEACON_CSP);
}

// POST /econopod/planner: the record planner (timda plan in the browser). Nothing is
// stored; the form comes back filled in, with the records in every format.
export async function planner({ request, env }) {
  const base = await (await env.ASSETS.fetch(new URL('/econopod', request.url))).text();
  let form;
  try { form = await request.formData(); } catch { form = new FormData(); }
  const values = plannerValues(form);
  const { checks, plan } = planFromValues(values);
  const title = `Plan: <span class="heard heard-${worstLevel(checks)}">${esc(values.domain || 'no domain')}</span>`;
  const html = fill(fill(base, 'planner-form', renderPlannerForm(values)), 'planner', renderChecks(title, checks) + (plan ? renderPlanFormats(plan) : ''));
  return htmlResponse(html, plan ? 200 : 400);
}

// POST /econopod: the mast's signal test. Checks a signed statement against its
// Section's live keys. Only looks: nothing is docked and the nonce isn't used up.
export async function signalTest({ request, env }, deps = {}) {
  const base = await (await env.ASSETS.fetch(new URL('/econopod', request.url))).text();
  const signed = await readSigned(request);
  if (signed.error) return htmlResponse(fill(base, 'signal', renderChecks('No signal', [['CRIT', signed.error]])), 400);
  const checks = await signalChecks({ ...signed, hub: env.HUB_DOMAIN || DEFAULT_HUB, fetchImpl: deps.fetchImpl ?? fetch, now: deps.now ?? new Date() });
  const worst = worstLevel(checks);
  const title = `<span class="heard heard-${worst}">${worst === 'crit' ? 'Signal lost' : 'Signal received'}</span>`;
  return htmlResponse(fill(base, 'signal', renderChecks(title, checks)), worst === 'crit' ? 400 : 200);
}

// POST /api/board: a Board resolution (approve, delist, reinstate, or the agenda),
// signed with the hub's own key. Answers on the Executive Suites page.
export async function boardRequest({ request, env }, deps = {}) {
  const asJson = wantsJson(request);
  const page = async (status, html) => {
    const base = await env.ASSETS.fetch(new URL('/executive-suites', request.url));
    return htmlResponse(fill(await base.text(), 'board-result', html), status);
  };
  if (!env.REGISTRY) return asJson ? jsonResponse(503, { ok: false, error: 'the hub\'s registry isn\'t set up yet' }) : page(503, notice('crit', 'The hub\'s registry isn\'t set up yet.'));
  const signed = await readSigned(request);
  if (signed.error) return asJson ? jsonResponse(400, { ok: false, error: signed.error }) : page(400, notice('crit', signed.error));
  const r = await board(env, { ...signed, hub: env.HUB_DOMAIN || DEFAULT_HUB, fetchImpl: deps.fetchImpl ?? fetch, now: deps.now ?? new Date() });
  if (asJson) {
    if (!r.ok) return jsonResponse(400, { ok: false, error: r.error });
    return jsonResponse(200, r.type === 'board-agenda'
      ? { ok: true, type: r.type, review: r.index.review, approved: r.index.domains, delisted: r.index.delisted }
      : { ok: true, type: r.type, section: r.target });
  }
  if (!r.ok) return page(400, notice('crit', `<strong>Motion failed.</strong> ${esc(r.error)}`));
  if (r.type === 'board-agenda') {
    const list = (title, ds) => `<p><strong>${title}:</strong> ${ds.length ? ds.map(esc).join(', ') : 'none'}</p>`;
    return page(200, notice('good', `<strong>The agenda.</strong>${list('Waiting for review', r.index.review)}${list('Approved', r.index.domains)}${list('Delisted', r.index.delisted)}`));
  }
  const did = { 'board-approve': 'is approved and listed', 'board-delist': 'is delisted, everywhere, at once', 'board-reinstate': 'is reinstated and listed' }[r.type];
  return page(200, notice('good', `<strong>Resolution carried.</strong> ${esc(r.target)} ${did}.`));
}

/**
 * Tell the hub's operator a new Section is waiting for review. Pages can't send email,
 * so this calls a small separate Worker (workers/notify) through the NOTIFY service
 * binding. Optional: without it, the Board finds new Sections with board-agenda. A
 * failure here never fails the dock request.
 */
export function notifyBoard({ request, env, waitUntil }, r) {
  if (!env.NOTIFY) return undefined;
  const host = new URL(request.url).host;
  const s = r.section;
  const text = [
    `${r.from} sent a dock request to ${host} and is waiting for review.`,
    '',
    `  Designation: ${s.name}`,
    `  Status:      ${s.status}`,
    ...(s.concept ? [`  Concept:     ${s.concept}`] : []),
    `  Airlock:     ${airlockUrl(r.from, s)}`,
    '',
    'Its records were checked and are valid. Nothing of it is shown until the Board approves it.',
    `To approve or delist it, table a motion at https://${host}/executive-suites`,
    '',
    `See its records: https://${host}/econopod?domain=${encodeURIComponent(r.from)}#beacon-test`,
  ].join('\n');
  const sent = env.NOTIFY.fetch('https://notify.invalid/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: `Dock request: ${r.from}${host === (env.HUB_DOMAIN || DEFAULT_HUB) ? '' : ` (${host})`}`, text }),
  }).catch(() => undefined);
  if (waitUntil) waitUntil(sent);
  return sent;
}

// POST /api/mail: the Wormhole Post, the inbox relay (TIMDA-3), for message, inbox and inbox-delete statements.
export async function mailRequest({ request, env }, deps = {}) {
  const hub = env.HUB_DOMAIN || DEFAULT_HUB;
  const page = async (status, html) => {
    const base = await env.ASSETS.fetch(new URL('/econopod', request.url));
    return htmlResponse(fill(await base.text(), 'post', html), status);
  };
  const reply = (status, r) => (wantsJson(request) ? jsonResponse(status, r) : page(status, renderRelay(r, hub)));
  if (!env.REGISTRY) return reply(503, { ok: false, error: 'the hub\'s registry isn\'t set up yet' });
  const signed = await readSigned(request);
  if (signed.error) return reply(400, { ok: false, error: signed.error });
  const r = await relay(env, { ...signed, hub, fetchImpl: deps.fetchImpl ?? fetch, now: deps.now ?? new Date() });
  return reply(r.ok ? 200 : 400, r);
}

// POST /api/dock: a signed dock request, as uploaded files (or pasted text).
export async function dockRequest({ request, env, waitUntil }, deps = {}) {
  const asJson = wantsJson(request);
  const page = async (status, html) => {
    const base = await env.ASSETS.fetch(new URL('/dock', request.url));
    return htmlResponse(fill(await base.text(), 'dock-result', html), status);
  };
  if (!env.REGISTRY) return asJson ? jsonResponse(503, { ok: false, error: 'the hub\'s registry isn\'t set up yet' }) : page(503, notice('crit', 'The hub\'s registry isn\'t set up yet, so it can\'t accept dock requests.'));

  const signed = await readSigned(request);
  if (signed.error) return asJson ? jsonResponse(400, { ok: false, error: signed.error }) : page(400, notice('crit', signed.error));

  const r = await dock(env, {
    ...signed, hub: env.HUB_DOMAIN || DEFAULT_HUB,
    fetchImpl: deps.fetchImpl ?? fetch, now: deps.now ?? new Date(),
  });
  if (r.ok && r.state === 'review' && !r.already) notifyBoard({ request, env, waitUntil }, r);
  if (asJson) {
    return r.ok
      ? jsonResponse(200, { ok: true, type: r.type, from: r.from, state: r.state, already: r.already, name: r.section.name, status: r.section.status })
      : jsonResponse(400, { ok: false, error: r.error });
  }
  if (!r.ok) return page(400, notice('crit', `<strong>Not docked.</strong> ${esc(r.error)}`));
  const who = `<strong>${esc(r.section.name)}</strong> (${esc(r.from)})`;
  if (r.state === 'review') {
    return page(200, notice('good', `${who} ${r.already ? 'is still' : 'is docked and'} waiting for review by the Board. Nothing of it is listed or shown until it's approved. Its records were checked and are valid.`));
  }
  const where = r.section.status === 'pending'
    ? 'Its status is <strong>pending</strong>, so it shows greyed out in the <a href="/hypermall">HyperMall</a>, and visitors aren\'t sent there until you change it to open.'
    : 'It\'s listed in the <a href="/hypermall">HyperMall</a>.';
  return page(200, notice('good', `${who} ${r.already ? 'was already docked; its records were re-checked' : 'is docked'}. ${where}`));
}
