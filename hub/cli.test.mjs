// The timda CLI (from the timda.space repo, when it's checked out alongside) against
// this hub's real route handlers: the JSON contract, end to end, with real ssh-keygen
// signatures and real age encryption.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardRequest, dockRequest, mailRequest } from './routes.mjs';
import { recordKeyFromSshPublicKey } from './timda1.mjs';

const CLI = new URL('../../timda.space/tools/timda.mjs', import.meta.url);
const have = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } };
const skip = (!existsSync(CLI) && 'timda.space not checked out alongside')
  || (!have('ssh-keygen', ['-?']) && 'ssh-keygen not installed') || (!have('age', ['--version']) && 'age not installed');

function kv() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

test('the timda CLI docks, sits on the Board, and sends, collects and clears mail through this hub', { skip }, async () => {
  const { run } = await import(CLI);
  const home = mkdtempSync(join(tmpdir(), 'timda-e2e-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', join(home, 'k')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', join(home, 'hub')]);
  execFileSync('age-keygen', ['-o', join(home, 'id.txt')], { stdio: 'ignore' });
  const recipient = execFileSync('age-keygen', ['-y', join(home, 'id.txt')]).toString().trim();
  const value = (f) => recordKeyFromSshPublicKey(readFileSync(join(home, f), 'utf8'));
  const zones = {
    'section72.net': { core: ['v=TIMDA1; name=Section 72; status=open'], key: [`v=TIMDA1; key=${value('k.pub')}`], inbox: [`v=TIMDA1; hub=timda.space; age=${recipient}`] },
    'timda.space': { core: ['v=TIMDA1; name=TIMDA; status=open; type=hub'], key: [`v=TIMDA1; key=${value('hub.pub')}`] },
  };
  writeFileSync(join(home, 'section.toml'), `domain = "section72.net"\nname = "Section 72"\nkeys = ["k.pub"]\n[inbox]\nhub = "timda.space"\nage = "${recipient}"\n[cli]\nsign_with = "k"\nage_identity = "id.txt"\n`);
  writeFileSync(join(home, 'board.toml'), 'domain = "timda.space"\nname = "TIMDA"\nkeys = ["hub.pub"]\n[cli]\nsign_with = "hub"\n');
  writeFileSync(join(home, 'body.txt'), 'Your station keeps answering our outside line.\n');

  const env = { REGISTRY: kv(), ASSETS: { fetch: async () => new Response('<!-- x -->', { headers: { 'content-type': 'text/html' } }) } };
  const routes = { '/api/dock': dockRequest, '/api/board': boardRequest, '/api/mail': mailRequest };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'cloudflare-dns.com') {
      const [, part, domain] = /^(?:_(key|inbox|airlock|charter|setting|button|banner)\.)?_timda\.(.+)$/.exec(u.searchParams.get('name')) ?? [];
      const recs = zones[domain]?.[part ?? 'core'] ?? [];
      return new Response(JSON.stringify({ Status: 0, AD: true, Answer: recs.map((d) => ({ type: 16, TTL: 300, data: `"${d}"` })) }));
    }
    assert.equal(u.origin, 'https://timda.space');
    return routes[u.pathname]({ request: new Request(url, init), env, waitUntil: () => {} }, { fetchImpl: globalThis.fetch });
  };
  const cli = async (...argv) => {
    const o = { out: '', err: '' };
    const code = await run(argv, { log: (s) => { o.out += `${s}\n`; }, error: (s) => { o.err += `${s}\n`; }, write: (s) => { o.out += s; } });
    return { code, ...o };
  };
  const me = ['--from', join(home, 'section.toml')];
  const board = ['--from', join(home, 'board.toml')];
  try {
    const dock = await cli('dock', ...me);
    assert.equal(dock.code, 0, dock.err);
    assert.match(dock.out, /docked, and waiting for review by the Board/);
    assert.match((await cli('board', 'agenda', ...board)).out, /Waiting: +section72\.net/);
    assert.match((await cli('board', 'approve', 'section72.net', ...board)).out, /Resolution carried: section72\.net is approved and listed/);
    // a Section playing Board, pointed at the real hub, is turned away
    assert.match((await cli('board', 'approve', 'section72.net', ...me, '--via', 'https://timda.space')).err, /motion failed: hub: must be timda\.space/);

    const sent = await cli('mail', 'send', 'section72.net', '--subject', 'The modem on bench 3', '--file', join(home, 'body.txt'), ...me);
    assert.equal(sent.code, 0, sent.err);
    assert.match(sent.out, /Sent section72\.net!timda\.space!section72\.net, message [0-9a-f]{10}, sealed with age/);
    const id = sent.out.match(/message ([0-9a-f]{10})/)[1];

    const inbox = await cli('mail', ...me);
    assert.equal(inbox.code, 0, inbox.err + inbox.out);
    assert.match(inbox.out, /✓ signed by section72\.net/);
    assert.match(inbox.out, /Envelope: sealed \(age\)\n\n  Your station keeps answering our outside line\.\n/);

    assert.match((await cli('mail', 'delete', id, ...me)).out, /Deleted 1; 0 left/);
    assert.match((await cli('mail', ...me)).out, /^No mail for section72\.net\./);
  } finally {
    globalThis.fetch = real;
  }
});
