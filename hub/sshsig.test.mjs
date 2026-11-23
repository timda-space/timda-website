import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { verifySshsig } from './sshsig.mjs';
import { recordKeyFromSshPublicKey } from './timda1.mjs';

let haveSshKeygen = true;
try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); } catch (e) { haveSshKeygen = e.code !== 'ENOENT'; }

function signWithSshKeygen(text, ns = 'timda') {
  const dir = mkdtempSync(join(tmpdir(), 'sshsig-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', join(dir, 'k')]);
  writeFileSync(join(dir, 'm'), text);
  execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', join(dir, 'k'), '-n', ns, join(dir, 'm')]);
  return { key: recordKeyFromSshPublicKey(readFileSync(join(dir, 'k.pub'), 'utf8')), armored: readFileSync(join(dir, 'm.sig'), 'utf8') };
}

const skip = !haveSshKeygen && 'ssh-keygen not installed';
const msg = 'timda-statement: 1\ntype: dock-request\n';

test('verifies a real ssh-keygen signature', { skip }, async () => {
  const { key, armored } = signWithSshKeygen(msg);
  assert.deepEqual(await verifySshsig({ message: new TextEncoder().encode(msg), armored, namespace: 'timda', allowedKeys: [key] }), { ok: true, key });
});

test('rejects tampering, the wrong namespace, and keys not in DNS', { skip }, async () => {
  const { key, armored } = signWithSshKeygen(msg);
  const m = new TextEncoder().encode(msg);
  assert.match((await verifySshsig({ message: new TextEncoder().encode(msg + 'x'), armored, namespace: 'timda', allowedKeys: [key] })).error, /does not verify/);
  assert.match((await verifySshsig({ message: m, armored, namespace: 'git', allowedKeys: [key] })).error, /namespace/);
  assert.match((await verifySshsig({ message: m, armored, namespace: 'timda', allowedKeys: ['ed25519:gRfC33kq8uaLHoEvSy5bcmJSP8M64BM8nn7g2atWtkY='] })).error, /not in the Section/);
  const other = signWithSshKeygen(msg, 'file');
  assert.match((await verifySshsig({ message: m, armored: other.armored, namespace: 'timda', allowedKeys: [other.key] })).error, /namespace/);
});

test('rejects garbage', async () => {
  assert.match((await verifySshsig({ message: new Uint8Array(), armored: 'hello', namespace: 'timda', allowedKeys: [] })).error, /not an SSH signature/);
  assert.match((await verifySshsig({ message: new Uint8Array(), armored: '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----', namespace: 'timda', allowedKeys: [] })).error, /SSHSIG|truncated/);
});

// No hardware key here, so build an sk-ssh-ed25519 signature the way a FIDO
// authenticator would, from a software Ed25519 key, and check the verifier accepts it.
test('verifies hardware-key (sk-ssh-ed25519) signatures, and requires a touch', async () => {
  const enc = new TextEncoder();
  const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
  const s = (b) => cat(u32(b.length), typeof b === 'string' ? enc.encode(b) : b);
  const str = (x) => s(typeof x === 'string' ? enc.encode(x) : x);
  const sha = async (a, d) => new Uint8Array(await webcrypto.subtle.digest(a, d));
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pk = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const pubBlob = cat(str('sk-ssh-ed25519@openssh.com'), str(pk), str('ssh:'));
  const make = async (flags) => {
    const signed = cat(enc.encode('SSHSIG'), str('timda'), str(new Uint8Array()), str('sha512'), str(await sha('SHA-512', enc.encode(msg))));
    const data = cat(await sha('SHA-256', enc.encode('ssh:')), Uint8Array.of(flags), u32(7), await sha('SHA-256', signed));
    const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, data));
    const sigBlob = cat(str('sk-ssh-ed25519@openssh.com'), str(raw), Uint8Array.of(flags), u32(7));
    const blob = cat(enc.encode('SSHSIG'), u32(1), str(pubBlob), str('timda'), str(new Uint8Array()), str('sha512'), str(sigBlob));
    return `-----BEGIN SSH SIGNATURE-----\n${btoa(String.fromCharCode(...blob))}\n-----END SSH SIGNATURE-----\n`;
  };
  const key = `sk-ed25519:${btoa(String.fromCharCode(...pk))}`;
  assert.deepEqual(await verifySshsig({ message: enc.encode(msg), armored: await make(0x01), namespace: 'timda', allowedKeys: [key] }), { ok: true, key });
  assert.match((await verifySshsig({ message: enc.encode(msg), armored: await make(0x00), namespace: 'timda', allowedKeys: [key] })).error, /user presence/);
});
