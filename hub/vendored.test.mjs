import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// hub/timda1.mjs is a copy of tools/timda1.mjs from the timda.space repo. When both
// repos are checked out side by side, make sure the copy hasn't drifted.
const upstream = new URL('../../timda.space/tools/timda1.mjs', import.meta.url);
test('hub/timda1.mjs matches timda.space/tools/timda1.mjs', { skip: !existsSync(upstream) && 'timda.space not checked out alongside' }, () => {
  const ours = readFileSync(new URL('./timda1.mjs', import.meta.url), 'utf8').replace(/^(\/\/ .*\n)+\n/, '');
  assert.equal(ours, readFileSync(upstream, 'utf8'), 'copy timda.space/tools/timda1.mjs over hub/timda1.mjs (keeping the header)');
});

const sshsigUpstream = new URL('../../timda.space/tools/sshsig.mjs', import.meta.url);
test('hub/sshsig.mjs matches timda.space/tools/sshsig.mjs', { skip: !existsSync(sshsigUpstream) && 'timda.space not checked out alongside' }, () => {
  const ours = readFileSync(new URL('./sshsig.mjs', import.meta.url), 'utf8').replace(/^(\/\/ .*\n)+\n/, '');
  assert.equal(ours, readFileSync(sshsigUpstream, 'utf8'), 'copy timda.space/tools/sshsig.mjs over hub/sshsig.mjs (keeping the header)');
});

// specs/ holds copies of the timda.space repo's specs, published at /rnd/timda-<n>.
const specsUpstream = new URL('../../timda.space/specs/', import.meta.url);
test('specs/ matches timda.space/specs', { skip: !existsSync(specsUpstream) && 'timda.space not checked out alongside' }, () => {
  const names = (dir) => readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
  const ours = new URL('../specs/', import.meta.url);
  assert.deepEqual(names(ours), names(specsUpstream), 'copy every spec from timda.space/specs into specs/');
  for (const f of names(ours)) assert.equal(readFileSync(new URL(f, ours), 'utf8'), readFileSync(new URL(f, specsUpstream), 'utf8'), `specs/${f} differs from timda.space/specs/${f}`);
});
