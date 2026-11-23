import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arrivals, banner, boardRequest, button, dockRequest, econopod, envBadge, feed, mailRequest, hypermall, lounge, next, planner, random, signalTest } from './routes.mjs';
import { recordKeyFromSshPublicKey } from './timda1.mjs';
import { planFromValues } from './planner.mjs';
import { CONFIG } from './config.mjs';

let haveSshKeygen = true;
try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); } catch (e) { haveSshKeygen = e.code !== 'ENOENT'; }
const skip = !haveSshKeygen && 'ssh-keygen not installed';

const PUBLIC = new URL('../public/', import.meta.url);
const NOW = new Date('2026-11-22T12:00:00Z');

// ---- stand-ins for Cloudflare --------------------------------------------------

function kv() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    puts: [],
    async put(k, v, opts) { m.set(k, v); this.puts.push([k, opts]); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}
const asset = async (path) => new Response(readFileSync(new URL(`${path === '/' ? 'index' : path.slice(1)}.html`, PUBLIC)), { headers: { 'content-type': 'text/html' } });
const ASSETS = { fetch: (u) => asset(new URL(u).pathname) };

/** DNS: { domain: { core: [...], key: [...], airlock: [...], ... } } served as DoH JSON,
 *  plus any other URL in `files` served as-is (Section buttons). */
function dns(zones, files = {}) {
  return async (url, init) => {
    if (files[url]) return new Response(files[url], { status: 200 });
    if (!url.startsWith('https://cloudflare-dns.com/')) return new Response('not found', { status: 404 });
    const name = new URL(url).searchParams.get('name');
    const [, part, domain] = /^(?:_(key|airlock|charter|setting|button|banner|inbox)\.)?_timda\.(.+)$/.exec(name) ?? [];
    const recs = zones[domain]?.[part ?? 'core'] ?? [];
    const ttl = zones[domain]?.ttl?.[part ?? 'core'] ?? 300;
    return new Response(JSON.stringify({ Status: 0, Answer: recs.map((data) => ({ type: 16, TTL: ttl, data: `"${data}"` })) }));
  };
}

function newKey() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', join(dir, 'k')]);
  return { dir, path: join(dir, 'k'), value: recordKeyFromSshPublicKey(readFileSync(join(dir, 'k.pub'), 'utf8')) };
}
function sign(key, text) {
  const f = join(key.dir, `s${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(f, text);
  execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', key.path, '-n', 'timda', f]);
  return { statement: readFileSync(f), signature: readFileSync(`${f}.sig`, 'utf8') };
}
const statement = (from, { hub = 'timda.space', issued = '2026-11-22T11:58:00Z', nonce = `n${Math.random().toString(36).slice(2)}abcdefghijklmnopqrstu` } = {}) =>
  `timda-statement: 1\ntype: dock-request\nfrom: ${from}\nhub: ${hub}\nissued: ${issued}\nnonce: ${nonce}\n`;

function post({ statement: st, signature }, asText = false) {
  const fd = new FormData();
  if (asText) fd.set('statement', st.toString().replace(/\n/g, '\r\n'));
  else fd.set('statement', new Blob([st]), 'dock.txt');
  fd.set('signature', new Blob([signature]), 'dock.txt.sig');
  return new Request('https://timda.space/api/dock', { method: 'POST', body: fd });
}
const section = (name, status, key, extra = {}) => ({
  core: [`v=TIMDA1; name=${name}; status=${status}; concept=Test place`],
  key: [`v=TIMDA1; key=${key.value}`],
  ...extra,
});
const text = async (res) => res.text();
/** Approve every Section waiting for review, as if the Board had (its signed flow is tested separately). */
function approveAll(env) {
  const i = JSON.parse(env.REGISTRY.m.get('registry'));
  env.REGISTRY.m.set('registry', JSON.stringify({ ...i, domains: [...new Set([...i.domains, ...i.review])].sort(), review: [] }));
}

// ---- tests ------------------------------------------------------------------------------

test('dock a Section with a signed request, then see it everywhere', { skip }, async () => {
  const key = newKey();
  const zones = { 'section72.net': section('Section 72', 'open', key, { airlock: ['v=TIMDA1; url=https://section72.net/airlock'], charter: ['v=TIMDA1; url=https://section72.net/charter'] }) };
  const env = { REGISTRY: kv(), ASSETS };
  const deps = { fetchImpl: dns(zones), now: NOW };

  const res = await dockRequest({ request: post(sign(key, statement('section72.net'))), env }, deps);
  const body = await text(res);
  assert.equal(res.status, 200, body.match(/<div class="notice[^]*?<\/div>/)?.[0]);
  assert.match(body, /<strong>Section 72<\/strong> \(section72\.net\) is docked and waiting for review by the Board/);
  assert.match(res.headers.get('content-security-policy'), /form-action 'self'/);
  assert.ok(env.REGISTRY.m.has('section:section72.net'));
  const waiting = await text(await hypermall({ env, request: new Request('https://timda.space/hypermall'), next: () => asset('/hypermall') }, deps));
  assert.match(waiting, /Units available/); // nothing shown before approval
  approveAll(env);

  const mall = await text(await hypermall({ env, request: new Request('https://timda.space/hypermall'), next: () => asset('/hypermall') }, deps));
  assert.match(mall, /<span class="status status-open">open<\/span> <a class="name" href="https:\/\/section72\.net\/airlock">Section 72<\/a>/);
  assert.match(mall, /<a href="https:\/\/section72\.net\/charter">Charter<\/a>/);
  assert.doesNotMatch(mall, /Units available/);

  const home = await text(await arrivals({ env, request: new Request('https://timda.space/'), next: () => asset('/') }, deps));
  assert.match(home, /<dt>Sections docked<\/dt><dd><!-- docked:start -->1<!-- docked:end --><\/dd>/);

  const r = await random({ env, request: new Request('https://timda.space/random') }, { ...deps, rand: () => 0 });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://section72.net/airlock');
  const n = await next({ env, request: new Request('https://timda.space/next?from=section72.net') }, deps);
  assert.equal(n.headers.get('location'), 'https://section72.net/airlock'); // only one: wraps round to itself
});

test('pasted text (CRLF from a textarea) still verifies', { skip }, async () => {
  const key = newKey();
  const env = { REGISTRY: kv(), ASSETS };
  const res = await dockRequest({ request: post(sign(key, statement('section72.net')), true), env }, { fetchImpl: dns({ 'section72.net': section('Section 72', 'open', key) }), now: NOW });
  assert.equal(res.status, 200);
});

test('a new dock request emails the Board through the notify Worker, once', { skip }, async () => {
  const key = newKey();
  const sent = [];
  const waited = [];
  const env = { REGISTRY: kv(), ASSETS, NOTIFY: { fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('sent'); } } };
  const deps = { fetchImpl: dns({ 'section72.net': section('Section 72', 'open', key) }), now: NOW };
  const go = () => dockRequest({ request: post(sign(key, statement('section72.net'))), env, waitUntil: (p) => waited.push(p) }, deps);
  assert.equal((await go()).status, 200);
  await Promise.all(waited);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Dock request: section72.net');
  assert.match(sent[0].text, /^section72\.net sent a dock request to timda\.space/);
  assert.match(sent[0].text, /Designation: Section 72\n/);
  assert.match(sent[0].text, /https:\/\/timda\.space\/executive-suites/);
  await go(); // still waiting: no second email
  assert.equal(sent.length, 1);

  // a broken notifier never breaks docking
  const env2 = { REGISTRY: kv(), ASSETS, NOTIFY: { fetch: async () => { throw new Error('down'); } } };
  const res = await dockRequest({ request: post(sign(key, statement('section72.net'))), env: env2, waitUntil: (p) => waited.push(p) }, deps);
  assert.equal(res.status, 200);
  await Promise.all(waited);
});

test('the notify Worker sends one plain-text email to its one address', async () => {
  // cloudflare:email only exists on Cloudflare; give Node a stand-in for it.
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
    if (s === 'cloudflare:email') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }') };
    return next(s, c);
  }`)}`);
  const { default: worker, rawMessage } = await import('../workers/notify/index.js');
  const mail = [];
  const env = { FROM: 'board@timda.space', TO: ' operator@example.com\n', EMAIL: { send: async (m) => { mail.push(m); return {}; } } };
  const post = (body) => new Request('https://notify.invalid/', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await worker.fetch(post({ subject: 'Dock request:\r\nBcc: x@example.com', text: 'hi\nthere' }), env)).status, 200);
  assert.equal(mail[0].from, 'board@timda.space');
  assert.equal(mail[0].to, 'operator@example.com'); // stray whitespace trimmed
  const [head, body] = mail[0].raw.split('\r\n\r\n');
  assert.match(head, /^From: TIMDA Board <board@timda\.space>\r\nTo: operator@example\.com\r\nSubject: Dock request: Bcc: x@example\.com\r\n/); // no header injection
  assert.match(head, /\r\nMessage-ID: <[0-9a-f-]{36}@timda\.space>\r\n/);
  assert.equal(body, 'hi\r\nthere');
  assert.match(rawMessage({ from: 'b@timda.space', to: 't@example.com', subject: 'Dock request: café.example', text: '' }), /\r\nSubject: =\?UTF-8\?B\?RG9jayByZXF1ZXN0OiBjYWbDqS5leGFtcGxl\?=\r\n/);
  assert.equal((await worker.fetch(post({ subject: 1 }), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://notify.invalid/'), env)).status, 405);
  assert.equal(mail.length, 1);
});

test('pending Sections dock, show greyed out, and are not routed to', { skip }, async () => {
  const key = newKey();
  const env = { REGISTRY: kv(), ASSETS };
  const deps = { fetchImpl: dns({ 'section72.net': section('Section 72', 'pending', key) }), now: NOW };
  await dockRequest({ request: post(sign(key, statement('section72.net'))), env }, deps);
  approveAll(env);
  const res = await dockRequest({ request: post(sign(key, statement('section72.net'))), env }, deps); // re-dock once approved
  assert.match(await text(res), /status is <strong>pending<\/strong>/);
  const mall = await text(await hypermall({ env, request: new Request('https://timda.space/hypermall'), next: () => asset('/hypermall') }, deps));
  assert.match(mall, /<li class="storefront storefront-pending"><span class="status status-pending">pending<\/span> <span class="name">Section 72<\/span>/);
  assert.doesNotMatch(mall, /href="https:\/\/section72\.net/); // no wormhole to a pending Section
  const r = await random({ env, request: new Request('https://timda.space/random') }, deps);
  assert.equal(r.headers.get('location'), 'https://timda.space/hypermall');
});

test('rejections: replay, wrong hub, stale, wrong key, no records, tampered', { skip }, async () => {
  const key = newKey();
  const other = newKey();
  const zones = { 'section72.net': section('Section 72', 'open', key) };
  const env = { REGISTRY: kv(), ASSETS };
  const deps = { fetchImpl: dns(zones), now: NOW };
  const go = async (signed, d = deps) => {
    const res = await dockRequest({ request: post(signed), env }, d);
    return { status: res.status, msg: (await text(res)).match(/<strong>Not docked\.<\/strong> ([^<]*)/)?.[1] ?? '' };
  };

  const once = sign(key, statement('section72.net'));
  assert.equal((await go(once)).status, 200);
  assert.match((await go(once)).msg, /already used/);
  assert.match((await go(sign(key, statement('section72.net', { hub: 'elsewhere.example' })))).msg, /hub: must be timda\.space/);
  assert.match((await go(sign(key, statement('section72.net', { issued: '2026-11-22T10:00:00Z' })))).msg, /sign a fresh statement/);
  assert.match((await go(sign(other, statement('section72.net')))).msg, /not in the Section/);
  assert.match((await go(sign(key, statement('nowhere.example')))).msg, /has no _timda records/);
  const t = sign(key, statement('section72.net'));
  assert.match((await go({ ...t, statement: Buffer.concat([t.statement, Buffer.from('extra: 1\n')]) })).msg, /does not verify/);
  // record content is escaped wherever it's shown
  const evil = { 'section72.net': section('<script>x</script>', 'open', key) };
  const r = await dockRequest({ request: post(sign(key, statement('section72.net'))), env }, { fetchImpl: dns(evil), now: NOW });
  assert.doesNotMatch(await text(r), /<script>x/);
});

test('Section buttons are fetched, checked, and served by the hub; bad ones never are', { skip }, async () => {
  const key = newKey();
  const png = readFileSync(new URL('ring/timda-88x31.png', PUBLIC));
  const zones = {
    'section72.net': section('Section 72', 'open', key, { button: ['v=TIMDA1; url=https://section72.net/88x31.png'] }),
    'section76.net': section('Section 76', 'open', key, { button: ['v=TIMDA1; url=https://section76.net/88x31.svg'] }),
    'offsite.example': section('Offsite', 'open', key, { button: ['v=TIMDA1; url=https://elsewhere.example/88x31.png'] }),
  };
  const files = {
    'https://section72.net/88x31.png': png,
    'https://section76.net/88x31.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="88" height="31"><script>alert(1)</script></svg>',
    'https://elsewhere.example/88x31.png': png,
  };
  const fetched = [];
  const fetchImpl = async (url, init) => { fetched.push(url); return dns(zones, files)(url, init); };
  const env = { REGISTRY: kv(), ASSETS };
  const deps = { fetchImpl, now: NOW };
  for (const d of Object.keys(zones)) {
    const res = await dockRequest({ request: post(sign(key, statement(d))), env }, deps);
    assert.equal(res.status, 200, d);
  }
  approveAll(env);

  const mall = await text(await hypermall({ env, request: new Request('https://timda.space/hypermall'), next: () => asset('/hypermall') }, deps));
  assert.match(mall, /<a class="button88" href="https:\/\/section72\.net\/" tabindex="-1"><img src="\/buttons\/section72\.net\?v=[0-9a-f]{10}" width="88" height="31" alt="Section 72"><\/a>/);
  assert.doesNotMatch(mall, /\/buttons\/section76\.net/);   // SVG refused
  assert.doesNotMatch(mall, /\/buttons\/offsite\.example/); // not on its own domain: never fetched
  assert.ok(!fetched.includes('https://elsewhere.example/88x31.png'));
  assert.doesNotMatch(mall, /src="https:/);                   // never hotlinked

  const r = await button({ env, params: { domain: 'section72.net' } }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.equal((await button({ env, params: { domain: 'section76.net' } }, deps)).status, 404);

  // not docked: 404 without looking anything up, so the hub isn't an image proxy
  fetched.length = 0;
  assert.equal((await button({ env, params: { domain: 'undocked.example' } }, deps)).status, 404);
  assert.deepEqual(fetched, []);
});

test('checks are reused for the shortest record TTL, between a minute and an hour', { skip }, async () => {
  const key = newKey();
  const cases = [[{}, 300], [{ key: 120 }, 120], [{ core: 30 }, 60], [{ core: 86400, key: 86400 }, 3600]];
  for (const [ttl, expected] of cases) {
    const env = { REGISTRY: kv(), ASSETS };
    const zones = { 'section72.net': { ...section('Section 72', 'open', key), ttl } };
    env.REGISTRY.m.set('section:section72.net', '{}');
    await hypermall({ env, request: new Request('https://timda.space/hypermall'), next: () => asset('/hypermall') }, { fetchImpl: dns(zones), now: NOW });
    const put = env.REGISTRY.puts.find(([k]) => k === 'check:section72.net');
    assert.equal(put?.[1]?.expirationTtl, expected, JSON.stringify(ttl));
  }
});

test('staging and previews get a badge and noindex; the live host is untouched', async () => {
  const page = () => asset('/hypermall');
  const live = await envBadge({ request: new Request('https://timda.space/hypermall'), next: page });
  assert.match(live.headers.get('cache-control') ?? '', /no-transform/); // nothing may be injected
  assert.equal(live.headers.get('x-robots-tag'), null);
  assert.doesNotMatch(await live.text(), /env-badge/);

  const staging = await envBadge({ request: new Request('https://staging.timda.space/hypermall'), next: page });
  assert.equal(staging.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(staging.headers.get('content-length'), null);
  assert.match(await staging.text(), /<body>\n<div class="env-badge" role="note">Staging<span>[^]*<a class="resync" href="https:\/\/timda\.space\/hypermall">Resynchronize<\/a>/);

  const preview = await envBadge({ request: new Request('https://abc123.timda-website.pages.dev/'), next: () => asset('/') });
  assert.match(await preview.text(), /env-badge" role="note">Preview</);

  // a reload: the conditional headers are dropped, so it gets the whole page and the badge
  let seen;
  const reload = await envBadge({
    request: new Request('https://staging.timda.space/', { headers: { 'if-none-match': '"abc"' } }),
    next: async (req) => { seen = req; return req?.headers.get('if-none-match') ? new Response(null, { status: 304 }) : asset('/'); },
  });
  assert.equal(seen.headers.get('if-none-match'), null);
  assert.equal(reload.status, 200);
  assert.match(await reload.text(), /env-badge/);
  // anything that isn't a 200 passes through untouched
  const redirect = await envBadge({ request: new Request('https://staging.timda.space/x'), next: async () => new Response(null, { status: 304, headers: { 'content-type': 'text/html' } }) });
  assert.equal(redirect.status, 304);

  // non-HTML passes through, with noindex
  const png = await envBadge({ request: new Request('https://staging.timda.space/buttons/x'), next: async () => new Response('x', { headers: { 'content-type': 'image/png' } }) });
  assert.equal(await png.text(), 'x');
  assert.equal(png.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('double slashes redirect to the single-slash path, on every host', async () => {
  for (const host of ['timda.space', 'staging.timda.space']) {
    const res = await envBadge({ request: new Request(`https://${host}//hypermall?x=1`), next: () => { throw new Error('should not reach the site'); } });
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), '/hypermall?x=1');
  }
});

test('the mast: beacon test reports a domain live, like finger', { skip }, async () => {
  const key = newKey();
  const zones = { 'section72.net': section('Section 72', 'open', key, { button: ['v=TIMDA1; url=https://section72.net/88x31.png'] }) };
  const files = { 'https://section72.net/88x31.png': readFileSync(new URL('ring/timda-88x31.png', PUBLIC)) };
  const deps = { fetchImpl: dns(zones, files), now: NOW };
  const page = () => asset('/econopod');
  const ok = await text(await econopod({ request: new Request('https://timda.space/econopod?domain=Section72.NET'), next: page }, deps));
  assert.match(ok, /Beacon: <span class="heard heard-warn">section72\.net<\/span>/); // all GOOD but DNSSEC
  assert.match(ok, /level-good">GOOD<\/span> core record valid \(status: open\)/);
  assert.match(ok, /level-good">GOOD<\/span> button: 88x31 PNG/);
  assert.match(ok, /<dl class="heard-records"><div><dt>Domain<\/dt><dd>section72\.net<\/dd><\/div><div><dt>Name<\/dt><dd>Section 72<\/dd><\/div>/);
  assert.match(ok, /<dt>Button<\/dt><dd>\/88x31\.png<\/dd>/); // own-domain links show just the path
  assert.match(ok, /<dt>Key<\/dt><dd><details class="keyval"><summary><code>ed25519:[A-Za-z0-9+\/]{6}&hellip;[A-Za-z0-9+\/=]{6}<\/code><\/summary><input type="text" readonly value="ed25519:[A-Za-z0-9+\/]{43}="/);
  assert.match(ok, /<figure class="sstv"><div class="sstv-screen"><img src="data:image\/png;base64,iVBOR[^"]*" width="176" height="62"/);
  assert.match(ok, /level-warn">WARN<\/span> DNSSEC not validated/);
  const none = await text(await econopod({ request: new Request('https://timda.space/econopod?domain=nowhere.example'), next: page }, deps));
  assert.match(none, /level-crit">CRIT<\/span> no _timda core record/);
  assert.match(none, /heard heard-crit">nowhere\.example/);
  const bad = await econopod({ request: new Request('https://timda.space/econopod?domain=%3Cscript%3E'), next: page }, deps);
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await text(bad), /<script>/);
  const plain = await econopod({ request: new Request('https://timda.space/econopod'), next: page }, deps);
  assert.match(await text(plain), /<!-- beacon:start --><!-- beacon:end -->/);
});

test('the mast: signal test checks a signature without docking or using the nonce', { skip }, async () => {
  const key = newKey();
  const other = newKey();
  const zones = { 'section72.net': section('Section 72', 'open', key) };
  const env = { REGISTRY: kv(), ASSETS };
  const deps = { fetchImpl: dns(zones), now: NOW };
  const signed = sign(key, statement('section72.net'));
  const post = (s) => { const r = new Request('https://timda.space/econopod', { method: 'POST', body: (() => { const fd = new FormData(); fd.set('statement', new Blob([s.statement]), 'dock.txt'); fd.set('signature', new Blob([s.signature]), 'dock.txt.sig'); return fd; })() }); return r; };

  const good = await signalTest({ request: post(signed), env }, deps);
  assert.equal(good.status, 200);
  const g = await text(good);
  assert.match(g, /heard heard-good">Signal received/);
  assert.match(g, /GOOD<\/span> signature verifies with ed25519:/);
  assert.match(g, /GOOD<\/span> issued within 10 minutes/);
  assert.equal(env.REGISTRY.m.size, 0); // nothing docked, no nonce used

  // ...so the very same statement still docks afterwards
  assert.equal((await dockRequest({ request: post(signed), env }, deps)).status, 200);

  const wrong = await signalTest({ request: post(sign(other, statement('section72.net'))), env }, deps);
  assert.equal(wrong.status, 400);
  assert.match(await text(wrong), /heard heard-crit">Signal lost[^]*CRIT<\/span> signed with a key that is not in the Section/);
  const stale = await text(await signalTest({ request: post(sign(key, statement('section72.net', { issued: '2026-11-22T10:00:00Z' }))), env }, deps));
  assert.match(stale, /WARN<\/span> issued 120 minutes from now/);
});

test('the Lounge rotates opt-in banners from open Sections, with captions, and can hold one', { skip }, async () => {
  const key = newKey();
  const png = (w, h) => { const b = new Uint8Array(64); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b; };
  const zones = {
    'section72.net': section('Section 72', 'open', key, { banner: ['v=TIMDA1; url=https://section72.net/468x60.png; caption=The 90s, in the future. <b>Now</b> at 60%25 off!'], button: ['v=TIMDA1; url=https://section72.net/88x31.png'], setting: ['v=TIMDA1; url=https://section72.net/setting'] }),
    'section76.net': section('Section 76', 'open', key, { banner: ['v=TIMDA1; url=https://section76.net/468x60.png'] }),
    'closed.example': section('Closed', 'closed', key, { banner: ['v=TIMDA1; url=https://closed.example/468x60.png'] }),
    'wrongsize.example': section('Wrong', 'open', key, { banner: ['v=TIMDA1; url=https://wrongsize.example/468x60.png'] }),
    'nobanner.example': section('Plain', 'open', key),
  };
  const files = {
    'https://section72.net/468x60.png': png(468, 60), 'https://section72.net/88x31.png': png(88, 31), 'https://section76.net/468x60.png': png(936, 120),
    'https://closed.example/468x60.png': png(468, 60), 'https://wrongsize.example/468x60.png': png(88, 31),
  };
  const env = { REGISTRY: kv(), ASSETS };
  for (const d of Object.keys(zones)) env.REGISTRY.m.set(`section:${d}`, '{}');
  const page = () => asset('/lounge');
  const at = (rand, url = 'https://timda.space/lounge') => lounge({ env, request: new Request(url), next: page }, { fetchImpl: dns(zones, files), now: NOW, rand });

  const first = await at(() => 0);
  assert.equal(first.headers.get('refresh'), null); // never reloads itself unless asked
  assert.match(await text(await at(() => 0)), /<a href="\/lounge">Next great idea<\/a> &middot; <a href="\/lounge\?rotate">Rotate every minute<\/a>/);
  const rotating = await at(() => 0, 'https://timda.space/lounge?rotate');
  assert.equal(rotating.headers.get('refresh'), '60'); // two banners to rotate between
  const h = await text(rotating);
  assert.match(h, /<img src="\/banners\/section72\.net\?v=[0-9a-f]{10}" width="468" height="60" alt="Section 72">/);
  assert.match(h, /The 90s, in the future\. &lt;b&gt;Now&lt;\/b&gt; at 60% off!/); // escaped
  assert.match(h, /<div class="host host-(robot|sage|alien|bix)"><svg class="host-portrait"/);
  assert.match(h, /<strong>Section 72<\/strong>/);
  assert.match(h, /<p class="showcase-button"><a href="https:\/\/section72\.net\/" tabindex="-1"><img src="\/buttons\/section72\.net\?v=[0-9a-f]{10}" width="88" height="31"/);
  assert.match(h, /href="\/lounge\?hold=section72\.net">Hold this view<\/a> &middot; <a href="\/lounge">Stop rotating/);
  const second = await text(await at(() => 0.99));
  assert.match(second, /\/banners\/section76\.net/);
  for (const d of ['closed\\.example', 'wrongsize\\.example', 'nobanner\\.example']) {
    for (const r of [0, 0.5, 0.99]) assert.doesNotMatch(await text(await at(() => r)), new RegExp(`/banners/${d}`));
  }
  const held = await at(() => 0.99, 'https://timda.space/lounge?hold=section72.net');
  assert.equal(held.headers.get('refresh'), null);
  const hh = await text(held);
  assert.match(hh, /\/banners\/section72\.net/);
  assert.match(hh, /Held\. <a href="\/lounge\?rotate">Rotate every minute<\/a>/);
  assert.equal((await at(() => 0.99, 'https://timda.space/lounge?rotate&hold=section72.net')).headers.get('refresh'), null); // holding wins

  const unknown = await at(() => 0, 'https://timda.space/lounge?rotate&hold=nowhere.example');
  assert.equal(unknown.headers.get('refresh'), '60'); // an unknown hold is ignored
  assert.doesNotMatch(await text(unknown), /Held\./);

  // With only one banner there's nothing to rotate: no Refresh, no rotation controls, an invitation instead.
  env.REGISTRY.m.delete('section:section76.net');
  env.REGISTRY.m.delete('registry'); // rebuilt from the section: keys
  for (const k of [...env.REGISTRY.m.keys()]) if (k.startsWith('check:')) env.REGISTRY.m.delete(k);
  const single = await at(() => 0, 'https://timda.space/lounge?rotate');
  assert.equal(single.headers.get('refresh'), null);
  const sh = await text(single);
  assert.doesNotMatch(sh, /href="\/lounge\?rotate"|>Next great idea</);
  assert.match(sh, /One great idea so far\. More on the way as Sections hang their banners\. <a href="\/dock#your-banner">Advertise here!<\/a>/);
  assert.match(sh, /\/banners\/section72\.net/);
  env.REGISTRY.m.set('section:section76.net', '{}');
  env.REGISTRY.m.delete('registry');

  const img = await banner({ env, params: { domain: 'section76.net' } }, { fetchImpl: dns(zones, files), now: NOW });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await banner({ env, params: { domain: 'wrongsize.example' } }, { fetchImpl: dns(zones, files), now: NOW })).status, 404);
});

test('an empty Lounge says so, and does not refresh', async () => {
  const env = { REGISTRY: kv(), ASSETS };
  const res = await lounge({ env, request: new Request('https://timda.space/lounge'), next: () => asset('/lounge') }, {});
  assert.equal(res.headers.get('refresh'), null);
  assert.match(await text(res), /The AuthentiGlass is clear/);
});

test('the record planner: a form in, checked records out in every format', { skip }, async () => {
  const key = newKey();
  const other = newKey();
  const pub = readFileSync(`${key.path}.pub`, 'utf8').trim();
  const env = { ASSETS };
  const post = (fields) => new Request('https://timda.space/econopod/planner', { method: 'POST', body: new URLSearchParams(fields) });

  // the empty form is on the mast page
  const page = await text(await econopod({ request: new Request('https://timda.space/econopod'), next: () => asset('/econopod') }, {}));
  assert.match(page, /<form class="dock planner" method="post" action="\/econopod\/planner#record-planner">/);

  const ok = await planner({ request: post({ domain: 'Section72.NET', name: 'Section 72 <b>', status: 'open', concept: 'The 90s; in the future', keys: `${pub}\n\n${other.value}`, banner: 'https://section72.net/468x60.png', caption: 'Hi', ttl: '300' }), env });
  assert.equal(ok.status, 200);
  const h = await text(ok);
  assert.match(h, /Plan: <span class="heard heard-good">section72\.net<\/span>/);
  assert.match(h, /GOOD<\/span> 2 keys: ed25519/); // the .pub line and the value, both accepted
  for (const label of ['Table', 'Zone file', 'Cloudflare', 'AWS Route 53']) assert.match(h, new RegExp(`<summary><h3>[^<]*${label}`));
  assert.match(h, /_timda\.section72\.net\. +300 IN TXT &quot;v=TIMDA1; name=Section 72 &lt;b&gt;; status=open; concept=The 90s%3B in the future&quot;/);
  assert.match(h, /resource &quot;aws_route53_record&quot;/);
  assert.match(h, /name="name" value="Section 72 &lt;b&gt;"/); // the form comes back filled in, escaped
  assert.doesNotMatch(h, /<b>/);

  for (const [fields, msg] of [
    [{ domain: '', name: 'X', keys: pub }, /enter your domain/],
    [{ domain: 'section72.net', name: 'X', keys: '' }, /paste at least one public key/],
    [{ domain: 'section72.net', name: 'X', keys: 'ssh-rsa AAAAB3Nza nope' }, /CRIT<\/span> key/],
    [{ domain: 'section72.net', name: 'X'.repeat(60), keys: pub }, /CRIT/],
    [{ domain: 'section72.net', name: 'X', keys: pub, ttl: '5' }, /TTL must be/],
  ]) {
    const r = await planner({ request: post(fields), env });
    assert.equal(r.status, 400, JSON.stringify(fields));
    const b = await text(r);
    assert.match(b, msg);
    assert.doesNotMatch(b, /plan-format/); // no records when they wouldn't be valid
  }
  const lonely = await text(await planner({ request: post({ domain: 'section72.net', name: 'X', keys: pub, caption: 'hi' }), env }));
  assert.match(lonely, /WARN<\/span> a caption only goes with a banner/);
});

test('the arrivals board announces dockings, status changes and departures, and a DNS hiccup is not one', { skip }, async () => {
  const key = newKey();
  const zones = { 'section72.net': section('Section 72 & Co', 'open', key) };
  const env = { REGISTRY: kv(), ASSETS };
  let fail = false;
  const live = dns(zones);
  const fetchImpl = (url, init) => (fail ? Promise.resolve(new Response('', { status: 502 })) : live(url, init));
  const at = (h) => ({ fetchImpl, now: new Date(`2026-11-22T${h}:00:00Z`) });
  const page = async (h) => text(await arrivals({ env, request: new Request('https://timda.space/'), next: () => asset('/') }, at(h)));
  const recheck = () => env.REGISTRY.m.delete('check:section72.net'); // records changed: as if the TTL ran out
  const board = () => JSON.parse(env.REGISTRY.m.get('announcements')).events.map((e) => `${e.at.slice(11, 13)} ${e.kind} ${e.status ?? ''}`.trim());

  assert.match(await page('12'), /No arrivals yet/);
  await dockRequest({ request: post(sign(key, statement('section72.net'))), env }, { fetchImpl, now: NOW });
  assert.match(await page('12'), /No arrivals yet/); // waiting for review: not announced
  approveAll(env);
  env.REGISTRY.m.set('section:section72.net', JSON.stringify({ docked: '2026-11-22T12:00:00.000Z', state: 'approved', approved: '2026-11-22T13:00:00.000Z' }));
  const p = await page('14');
  assert.match(p, /<tr><td><time datetime="2026-11-22T13:00:00.000Z">2026-11-22<\/time><\/td><td><a href="https:\/\/section72\.net\/">Section 72 &amp; Co<\/a><\/td><td class="status-open">Docked<\/td><\/tr>/);
  assert.match(p, /<dd><!-- docked:start -->1<!-- docked:end --><\/dd>/);
  const writes = env.REGISTRY.puts.filter(([k]) => k === 'announcements').length;
  await page('13');
  assert.equal(env.REGISTRY.puts.filter(([k]) => k === 'announcements').length, writes); // nothing new, no write

  zones['section72.net'].core = ['v=TIMDA1; name=Section 72 & Co; status=closed']; recheck();
  assert.match(await page('14'), /<td>Section 72 &amp; Co<\/td><td class="status-closed">Now closed<\/td>/); // no link when closed
  fail = true; recheck();
  await page('15');
  assert.deepEqual(board(), ['14 status closed', '13 arrived open']); // a failed lookup changes nothing
  fail = false; delete zones['section72.net'].core; recheck();
  assert.match(await page('16'), /<td>Section 72 &amp; Co<\/td><td class="gone">Undocked<\/td>/);
  zones['section72.net'].core = ['v=TIMDA1; name=Section 72 & Co; status=open']; recheck();
  await page('17');
  const i = JSON.parse(env.REGISTRY.m.get('registry')); // the Board delists it
  env.REGISTRY.m.set('registry', JSON.stringify({ ...i, domains: [], delisted: ['section72.net'] }));
  await page('18');
  assert.deepEqual(board(), ['18 left', '17 returned open', '16 left', '14 status closed', '13 arrived open']);

  const f = await feed({ env, request: new Request('https://timda.space/feed') }, at('18'));
  assert.equal(f.headers.get('content-type'), 'application/atom+xml; charset=utf-8');
  const xml = await text(f);
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(xml, /<updated>2026-11-22T18:00:00\.000Z<\/updated>/);
  assert.equal(xml.match(/<entry>/g).length, 5);
  assert.match(xml, /<title>Section 72 &amp; Co: returned<\/title>\n    <updated>2026-11-22T17:00:00\.000Z<\/updated>\n    <link href="https:\/\/section72\.net\/"\/>/);
  assert.match(xml, /<title>Section 72 &amp; Co is now closed<\/title>/);
  assert.match(xml, /<id>tag:timda\.space,2026:section72\.net\/arrived\/2026-11-22T13:00:00\.000Z<\/id>/);
  // with no registry, an empty but valid feed
  assert.match(await text(await feed({ env: {}, request: new Request('https://timda.space/feed') })), /<feed[^]*<\/feed>\n$/);
});

test('KV stays cheap: pages read one index key, never list; checks go to the edge cache', { skip }, async () => {
  const key = newKey();
  const zones = { 'section72.net': section('Section 72', 'open', key) };
  const deps = { fetchImpl: dns(zones), now: NOW };
  const env = { REGISTRY: kv(), ASSETS };
  let lists = 0;
  const list = env.REGISTRY.list.bind(env.REGISTRY);
  env.REGISTRY.list = async (o) => { lists++; return list(o); };

  // docking writes the section key and the index; no list is needed after that
  assert.equal((await dockRequest({ request: post(sign(key, statement('section72.net'))), env }, deps)).status, 200);
  assert.deepEqual(JSON.parse(env.REGISTRY.m.get('registry')), { domains: [], review: ['section72.net'], delisted: [] });
  approveAll(env);
  const before = lists;
  for (let i = 0; i < 5; i++) await hypermall({ env, request: new Request('https://timda.space/hypermall'), next: () => asset('/hypermall') }, deps);
  assert.equal(lists, before);

  // with an edge cache, checks never touch KV
  const store = new Map();
  globalThis.caches = { default: {
    match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined),
    put: async (k, res) => { store.set(k, await res.text()); },
    delete: async (k) => store.delete(k),
  } };
  try {
    const puts = env.REGISTRY.puts.length;
    const mall = await text(await hypermall({ env, request: new Request('https://timda.space/hypermall'), next: () => asset('/hypermall') }, deps));
    assert.match(mall, /Section 72/);
    assert.equal(env.REGISTRY.puts.length, puts); // no KV write for the check
    assert.ok(store.has('https://timda.space/__hub-cache/v1/check/section72.net'));
  } finally {
    delete globalThis.caches;
  }
});

test('the Board: new Sections wait for review; only the hub key approves, delists or reinstates', { skip }, async () => {
  const hubKey = newKey();
  const s76 = newKey();
  const zones = {
    'timda.space': { core: ['v=TIMDA1; name=TIMDA; status=open; type=hub'], key: [`v=TIMDA1; key=${hubKey.value}`] },
    'section76.net': section('Section 76', 'open', s76, { button: ['v=TIMDA1; url=https://section76.net/88x31.png'] }),
  };
  const png = new Uint8Array(64);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 88); new DataView(png.buffer).setUint32(20, 31);
  const deps = { fetchImpl: dns(zones, { 'https://section76.net/88x31.png': png }), now: NOW };
  const env = { REGISTRY: kv(), ASSETS };
  const resolution = (type, extra = '', from = 'timda.space') => `timda-statement: 1\ntype: ${type}\nfrom: ${from}\nhub: timda.space\nissued: 2026-11-22T11:58:00Z\nnonce: n${Math.random().toString(36).slice(2)}abcdefghijklmnopqrstu\n${extra}`;
  const motion = async (signer, text) => {
    const r = await boardRequest({ request: post(sign(signer, text)), env }, deps);
    return { status: r.status, body: await text_(r) };
  };
  const text_ = (r) => r.text();
  const mall = async () => text_(await hypermall({ env, request: new Request('https://timda.space/hypermall'), next: () => asset('/hypermall') }, deps));

  // docking: valid, but waiting; nothing of it shown or served
  assert.equal((await dockRequest({ request: post(sign(s76, statement('section76.net'))), env }, deps)).status, 200);
  assert.doesNotMatch(await mall(), /Section 76/);
  assert.equal((await button({ env, params: { domain: 'section76.net' } }, deps)).status, 404);

  // the agenda, for the hub key only
  const agenda = await motion(hubKey, resolution('board-agenda'));
  assert.equal(agenda.status, 200);
  assert.match(agenda.body, /Waiting for review:<\/strong> section76\.net/);
  const sneaky = await motion(s76, resolution('board-approve', 'section: section76.net\n', 'section76.net'));
  assert.equal(sneaky.status, 400);
  assert.match(sneaky.body, /only timda\.space&#39;s own keys|only timda\.space's own keys/);
  assert.match((await motion(hubKey, resolution('board-approve', 'section: nowhere.example\n'))).body, /hasn&#39;t asked to dock|hasn't asked to dock/);

  // approve: listed, and its button served
  const ok = await motion(hubKey, resolution('board-approve', 'section: section76.net\n'));
  assert.match(ok.body, /Resolution carried\.<\/strong> section76\.net is approved and listed/);
  assert.match(await mall(), /Section 76/);
  assert.equal((await button({ env, params: { domain: 'section76.net' } }, deps)).status, 200);

  // delist: gone at once, images too, and it can't dock its way back
  assert.match((await motion(hubKey, resolution('board-delist', 'section: section76.net\nreason: wares\n'))).body, /is delisted, everywhere, at once/);
  assert.doesNotMatch(await mall(), /Section 76/);
  assert.equal((await button({ env, params: { domain: 'section76.net' } }, deps)).status, 404);
  const back = await dockRequest({ request: post(sign(s76, statement('section76.net'))), env }, deps);
  assert.equal(back.status, 400);
  assert.match(await text_(back), /this hub has delisted section76\.net/);
  assert.equal(JSON.parse(env.REGISTRY.m.get('section:section76.net')).reason, 'wares');

  // reinstate
  assert.match((await motion(hubKey, resolution('board-reinstate', 'section: section76.net\n'))).body, /is reinstated and listed/);
  assert.match(await mall(), /Section 76/);
});

test('without the registry bound, pages fall back to static and docking says so', async () => {
  const env = { ASSETS };
  const res = await hypermall({ env, request: new Request('https://timda.space/hypermall'), next: () => asset('/hypermall') });
  assert.match(await text(res), /Units available/);
  const d = await dockRequest({ request: new Request('https://timda.space/api/dock', { method: 'POST', body: new FormData() }), env });
  assert.equal(d.status, 503);
});

test('Wormhole Post: signed mail between listed Sections, held as signed, collected and cleared by the recipient', { skip }, async () => {
  const AGE = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';
  const k72 = newKey(), k76 = newKey(), k77 = newKey(), k99 = newKey(), hubKey = newKey();
  const zones = {
    'section72.net': section('Section 72', 'open', k72),
    'section76.net': section('Section 76', 'open', k76, { inbox: ['v=TIMDA1; hub=timda.space'] }),
    'section77.net': section('Section 77', 'open', k77, { inbox: [`v=TIMDA1; hub=timda.space; age=${AGE}`] }),
    'section99.net': section('Section 99', 'open', k99, { inbox: ['v=TIMDA1; hub=timda.space'] }),
    'timda.space': { core: ['v=TIMDA1; name=TIMDA; status=open; type=hub'], key: [`v=TIMDA1; key=${hubKey.value}`], inbox: ['v=TIMDA1; hub=timda.space'] },
  };
  const env = { REGISTRY: kv(), ASSETS };
  env.REGISTRY.m.set('registry', JSON.stringify({ domains: ['section72.net', 'section76.net', 'section77.net'], review: ['section99.net'], delisted: [] }));
  const deps = { fetchImpl: dns(zones), now: NOW };
  const nonce = () => `n${Math.random().toString(36).slice(2)}abcdefghijklmnopqrstu`;
  const st = (type, from, headers = '', body = '') =>
    `timda-statement: 1\ntype: ${type}\nfrom: ${from}\nhub: timda.space\nissued: 2026-11-22T11:58:00Z\nnonce: ${nonce()}\n${headers}${body ? `\n${body}` : ''}`;
  const send = async (key, text) => {
    const res = await mailRequest({ request: post(sign(key, text)), env }, deps);
    const html = await res.text();
    return { status: res.status, html, said: html.match(/<div class="notice[^]*?<\/div>/)?.[0] ?? '' };
  };

  // send, and it's held for the recipient
  const sent = await send(k72, st('message', 'section72.net', 'to: section76.net\nsubject: The modem on bench 3\n', 'Your station keeps answering our outside line.\n'));
  assert.equal(sent.status, 200, sent.said);
  assert.match(sent.said, /<strong>Transmitted\.<\/strong> section72\.net<span class="bang">!<\/span><wbr>timda\.space<span class="bang">!<\/span><wbr>section76\.net, message <code>[0-9a-f]{10}<\/code> \(&ldquo;The modem on bench 3&rdquo;\)/);
  assert.match(sent.said, /^<div class="notice notice-warn"[^]*<span class="envelope envelope-open">Not encrypted<\/span>: this hub can read it/);
  const id = sent.said.match(/<code>([0-9a-f]{10})<\/code>/)[1];
  assert.ok(env.REGISTRY.m.has(`mail:section76.net:${id}`));
  assert.equal(env.REGISTRY.puts.find(([k]) => k === `mail:section76.net:${id}`)[1].expirationTtl, 30 * 24 * 3600);

  // collect it: shown, with the exact signed bytes to check; reading never deletes
  for (let i = 0; i < 2; i++) {
    const inbox = await send(k76, st('inbox', 'section76.net'));
    assert.equal(inbox.status, 200, inbox.said);
    assert.match(inbox.said, /<strong>1 message<\/strong> for section76\.net/);
    assert.match(inbox.html, /<dt>Envelope<\/dt><dd class="envelope envelope-open">Open: the hub can read it<\/dd>/);
    assert.match(inbox.html, /<pre class="mail-body">Your station keeps answering our outside line\.\n<\/pre>/);
    const link = inbox.html.match(new RegExp(`download="${id}\\.txt" href="data:text/plain;charset=utf-8;base64,([^"]+)"`));
    const held = JSON.parse(env.REGISTRY.m.get(`mail:section76.net:${id}`));
    assert.equal(Buffer.from(link[1], 'base64').toString(), held.statement);
    assert.match(held.signature, /^-----BEGIN SSH SIGNATURE-----/);
  }
  assert.match((await send(k72, st('inbox', 'section72.net'))).said, /<strong>No mail<\/strong> for section72\.net/);

  // encryption: an inbox with an age key takes age ciphertext only; one without takes none
  const armor = '-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOQ\n-----END AGE ENCRYPTED FILE-----\n';
  assert.match((await send(k72, st('message', 'section72.net', 'to: section77.net\n', 'plain\n'))).said, /takes encrypted mail only: encrypt the body with age -a -r age1ql3z/);
  const sealed = await send(k72, st('message', 'section72.net', 'to: section77.net\nencrypted: age\n', armor));
  assert.equal(sealed.status, 200, sealed.said);
  assert.match(sealed.said, /^<div class="notice notice-good"[^]*<span class="envelope envelope-sealed">Sealed with age<\/span>: only the recipient can read it/);
  const opened = await send(k77, st('inbox', 'section77.net'));
  assert.match(opened.html, /<dd class="envelope envelope-sealed">Sealed \(age\)<\/dd>/);
  assert.match(opened.html, /Encrypted with age[^]*download="[0-9a-f]{10}\.age"/);
  assert.doesNotMatch(opened.html, /mail-body/);
  assert.match((await send(k72, st('message', 'section72.net', 'to: section76.net\nencrypted: age\n', armor))).said, /publishes no age key/);

  // only between Sections listed here (or the hub itself), with an inbox here
  assert.match((await send(k72, st('message', 'section72.net', 'to: section99.net\n', 'hi\n'))).said, /section99\.net isn't docked and approved here/);
  assert.match((await send(k99, st('message', 'section99.net', 'to: section76.net\n', 'hi\n'))).said, /section99\.net isn't docked and approved here, so this hub won't carry its mail/);
  assert.match((await send(k76, st('message', 'section76.net', 'to: section72.net\n', 'hi\n'))).said, /section72\.net has no inbox/);
  assert.equal((await send(k72, st('message', 'section72.net', 'to: timda.space\nsubject: Hello, Board\n', 'hi\n'))).status, 200);
  assert.match((await send(k72, st('message', 'section72.net', 'to: section76.net\n', 'hi\n').replace('hub: timda.space', 'hub: elsewhere.example'))).said, /hub: must be timda\.space/);
  assert.match((await send(k72, st('message', 'section72.net', 'to: section76.net\n'))).said, /has no body/);
  assert.match((await send(k72, st('dock-request', 'section72.net'))).said, /takes message, inbox and inbox-delete statements, not dock-request/);

  // sizes: a message may be 8 KiB (more than other statements' 4 KiB), not more
  assert.equal((await send(k72, st('message', 'section72.net', 'to: section76.net\n', `${'x'.repeat(5000)}\n`))).status, 200);
  assert.match((await send(k72, st('message', 'section72.net', 'to: section76.net\n', `${'x'.repeat(8200)}\n`))).said, /over 8192 bytes/);
  assert.match((await send(k72, st('inbox', 'section72.net', `x-pad: ${'x'.repeat(4200)}\n`))).said, /an? inbox statement is at most 4096 bytes/);

  // limits are refused out loud
  env.REGISTRY.m.set('mailrate:section72.net:2026-11-22', '20');
  assert.match((await send(k72, st('message', 'section72.net', 'to: section76.net\n', 'hi\n'))).said, /has sent 20 messages today/);

  // clear: by ID, saying what wasn't there; then all
  const cleared = await send(k76, st('inbox-delete', 'section76.net', `delete: ${id}, 0000000000\n`));
  assert.match(cleared.said, /<strong>Cleared\.<\/strong> Deleted 1 message for section76\.net; 1 left\. Not found: <code>0000000000<\/code>/);
  assert.ok(!env.REGISTRY.m.has(`mail:section76.net:${id}`));
  assert.match((await send(k76, st('inbox-delete', 'section76.net', 'delete: all\n'))).said, /Deleted 1 message for section76\.net; 0 left/);
  assert.match((await send(k76, st('inbox-delete', 'section76.net', 'delete: nope\n'))).said, /10 hex characters/);
});

test('the record planner writes an inbox record, and checks the age key', () => {
  const K = 'ed25519:gRfC33kq8uaLHoEvSy5bcmJSP8M64BM8nn7g2atWtkY=';
  const base = { domain: 'section76.net', name: 'Section 76', status: 'open', keys: K, ttl: '300', airlock: '', charter: '', setting: '', button: '', banner: '', caption: '' };
  const AGE = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';
  const ok = planFromValues({ ...base, inbox: 'timda.space', age: AGE });
  assert.ok(ok.plan);
  assert.deepEqual(ok.plan.records.at(-1), { name: '_inbox._timda.section76.net', content: `v=TIMDA1; hub=timda.space; age=${AGE}` });
  assert.ok(ok.checks.some(([l, t]) => l === 'GOOD' && /inbox: held at timda\.space, encrypted/.test(t)));
  const bad = planFromValues({ ...base, inbox: 'timda.space', age: 'age1nope' });
  assert.equal(bad.plan, undefined);
  assert.ok(bad.checks.some(([l, t]) => l === 'CRIT' && /age key/.test(t)));
  assert.ok(planFromValues({ ...base, inbox: '', age: AGE }).checks.some(([l, t]) => l === 'WARN' && /only goes with an inbox/.test(t)));
});

test('an open hub (CONFIG.docking.review off) lists a new Section at once, and tells nobody', { skip }, async () => {
  const key = newKey();
  const sent = [];
  const env = { REGISTRY: kv(), ASSETS, NOTIFY: { fetch: async (u, init) => { sent.push(init); return new Response('sent'); } } };
  const deps = { fetchImpl: dns({ 'section72.net': section('Section 72', 'open', key) }), now: NOW };
  CONFIG.docking.review = false;
  try {
    const res = await dockRequest({ request: post(sign(key, statement('section72.net'))), env }, deps);
    assert.match(await text(res), /<strong>Section 72<\/strong> \(section72\.net\) is docked\. It's listed in the/);
    assert.deepEqual(JSON.parse(env.REGISTRY.m.get('registry')).domains, ['section72.net']);
    assert.equal(sent.length, 0);
  } finally {
    CONFIG.docking.review = true;
  }
});

test('Wormhole Post: mail is there the moment it is sent; no KV lists; older mail still found', { skip }, async () => {
  const k72 = newKey(), k76 = newKey();
  const zones = {
    'section72.net': section('Section 72', 'open', k72),
    'section76.net': section('Section 76', 'open', k76, { inbox: ['v=TIMDA1; hub=timda.space'] }),
  };
  const env = { REGISTRY: kv(), ASSETS };
  env.REGISTRY.m.set('registry', JSON.stringify({ domains: ['section72.net', 'section76.net'], review: [], delisted: [] }));
  // mail held before mailbox keys existed: found by one list, then indexed
  env.REGISTRY.m.set('mail:section76.net:0123456789', JSON.stringify({ id: '0123456789', from: 'section72.net', to: 'section76.net', subject: 'Old', received: '2026-11-21T00:00:00.000Z', encrypted: false, statement: 'timda-statement: 1\n\nold\n', signature: 'sig' }));
  let lists = 0;
  const list = env.REGISTRY.list.bind(env.REGISTRY);
  env.REGISTRY.list = async (o) => { lists++; return list(o); };
  const deps = { fetchImpl: dns(zones), now: NOW };
  const st = (type, from, headers = '', body = '') =>
    `timda-statement: 1\ntype: ${type}\nfrom: ${from}\nhub: timda.space\nissued: 2026-11-22T11:58:00Z\nnonce: n${Math.random().toString(36).slice(2)}abcdefghijklmnopqrstu\n${headers}${body ? `\n${body}` : ''}`;
  const send = async (key, text) => (await post2(key, text)).text();
  const post2 = (key, text) => mailRequest({ request: post(sign(key, text)), env }, deps);

  assert.match(await send(k72, st('message', 'section72.net', 'to: section76.net\nsubject: New\n', 'hi\n')), /Transmitted/);
  assert.equal(lists, 1); // the one-off look for older mail
  env.REGISTRY.list = async () => { lists++; return { keys: [], list_complete: true }; }; // a list that lags behind
  const inbox = await send(k76, st('inbox', 'section76.net'));
  assert.match(inbox, /<strong>2 messages<\/strong> for section76\.net/);
  assert.match(inbox, /Old[^]*New/); // oldest first
  assert.equal(lists, 1); // collecting didn't list
  assert.match(await send(k76, st('inbox-delete', 'section76.net', 'delete: all\n')), /Deleted 2 messages for section76\.net; 0 left/);
  assert.equal(env.REGISTRY.m.get('mailbox:section76.net'), '[]');
  assert.match(await send(k76, st('inbox', 'section76.net')), /<strong>No mail<\/strong>/);
  assert.equal(lists, 1); // an empty inbox isn't listed either
  assert.match(await send(k72, st('inbox', 'section72.net')), /<strong>No mail<\/strong>/);
  assert.equal(lists, 2); // a never-used one is looked at once…
  await send(k72, st('inbox', 'section72.net'));
  assert.equal(lists, 2); // …and never again
});

test('programs get JSON: dock, the Board and the Wormhole Post answer Accept: application/json', { skip }, async () => {
  const k72 = newKey(), hubKey = newKey();
  const zones = {
    'section72.net': section('Section 72', 'open', k72, { inbox: ['v=TIMDA1; hub=timda.space'] }),
    'timda.space': { core: ['v=TIMDA1; name=TIMDA; status=open; type=hub'], key: [`v=TIMDA1; key=${hubKey.value}`] },
  };
  const env = { REGISTRY: kv(), ASSETS };
  const deps = { fetchImpl: dns(zones), now: NOW };
  const st = (type, from, headers = '', body = '') =>
    `timda-statement: 1\ntype: ${type}\nfrom: ${from}\nhub: timda.space\nissued: 2026-11-22T11:58:00Z\nnonce: n${Math.random().toString(36).slice(2)}abcdefghijklmnopqrstu\n${headers}${body ? `\n${body}` : ''}`;
  const call = async (route, key, text) => {
    const req = post(sign(key, text));
    const headers = new Headers(req.headers);
    headers.set('accept', 'application/json');
    const res = await route({ request: new Request(req, { headers }), env }, deps);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    return { status: res.status, body: await res.json() };
  };

  assert.deepEqual(await call(dockRequest, k72, st('dock-request', 'section72.net')),
    { status: 200, body: { ok: true, type: 'dock-request', from: 'section72.net', state: 'review', already: false, name: 'Section 72', status: 'open' } });
  assert.deepEqual((await call(boardRequest, hubKey, st('board-agenda', 'timda.space'))).body, { ok: true, type: 'board-agenda', review: ['section72.net'], approved: [], delisted: [] });
  assert.deepEqual((await call(boardRequest, hubKey, st('board-approve', 'timda.space', 'section: section72.net\n'))).body, { ok: true, type: 'board-approve', section: 'section72.net' });
  assert.deepEqual(await call(boardRequest, k72, st('board-approve', 'section72.net', 'section: section72.net\n')),
    { status: 400, body: { ok: false, error: "only timda.space's own keys can sign Board resolutions" } });

  const sent = await call(mailRequest, k72, st('message', 'section72.net', 'to: section72.net\nsubject: Hi\n', 'hello\n'));
  assert.equal(sent.status, 200);
  assert.deepEqual(Object.keys(sent.body).sort(), ['encrypted', 'from', 'hub', 'id', 'ok', 'subject', 'to', 'type']);
  const inbox = (await call(mailRequest, k72, st('inbox', 'section72.net'))).body;
  assert.equal(inbox.mail.length, 1);
  assert.match(inbox.mail[0].statement, /\n\nhello\n$/);
  assert.match(inbox.mail[0].signature, /^-----BEGIN SSH SIGNATURE-----/);
});
