import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDeletions, prune } from '../workers/prune/index.js';

const dep = (n) => ({ id: `d${n}`, created_on: new Date(Date.UTC(2026, 0, n)).toISOString() });
const many = (n) => Array.from({ length: n }, (_, i) => dep(i + 1));

test('prune: keeps the newest N, whatever order they arrive in', () => {
  const gone = pickDeletions(many(15).reverse(), 10).map((d) => d.id);
  assert.deepEqual(gone.sort(), ['d1', 'd2', 'd3', 'd4', 'd5']);
});

test('prune: never deletes a protected deployment, however old', () => {
  const gone = pickDeletions(many(15), 10, ['d1', undefined]).map((d) => d.id);
  assert.ok(!gone.includes('d1'));
  assert.equal(gone.length, 4);
});

test('prune: fewer than N means nothing goes', () => {
  assert.deepEqual(pickDeletions(many(4), 10), []);
});

function fakeApi({ production, preview }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || 'GET'} ${u.pathname}${u.search}`);
    const ok = (result) => new Response(JSON.stringify({ success: true, result }));
    if (init.method === 'DELETE') return ok(null);
    if (u.pathname.endsWith('/deployments')) {
      const list = u.searchParams.get('env') === 'production' ? production : preview;
      const page = Number(u.searchParams.get('page'));
      return ok(list.slice((page - 1) * 25, page * 25));
    }
    return ok({ canonical_deployment: { id: 'd1' }, latest_deployment: { id: 'd15' } });
  };
  return calls;
}
const env = { CF_API_TOKEN: 't', ACCOUNT_ID: 'a', KEEP: '10' };

test('prune: dry run deletes nothing, and says what it would', async () => {
  const calls = fakeApi({ production: many(15), preview: many(3) });
  const logs = [];
  const s = await prune(env, (m) => logs.push(m));
  assert.equal(calls.filter((c) => c.startsWith('DELETE')).length, 0);
  assert.deepEqual(s, { production: { seen: 15, deleting: 4 }, preview: { seen: 3, deleting: 0 } });
  assert.ok(logs.some((l) => l.startsWith('would delete production d2')));
});

test('prune: DRY_RUN=false deletes with force, sparing the live deployment', async () => {
  const calls = fakeApi({ production: many(15), preview: many(12) });
  await prune({ ...env, DRY_RUN: 'false' }, () => {});
  const deletes = calls.filter((c) => c.startsWith('DELETE'));
  assert.equal(deletes.length, 4 + 1); // production loses d2-d5 (not d1); preview would lose d1, d2, but d1 is live
  assert.ok(deletes.every((c) => c.endsWith('?force=true')));
  assert.ok(!deletes.some((c) => c.includes('/d1?')));
});

test('prune: refuses a silly KEEP', async () => {
  fakeApi({ production: [], preview: [] });
  await assert.rejects(prune({ ...env, KEEP: '0' }, () => {}), /KEEP/);
});
