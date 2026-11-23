// The Wormhole Post: the hub's inbox relay (TIMDA-3).
//
// A message is a signed statement from one listed Section to another. The hub checks
// it against both Sections' live DNS records, then holds it, exactly as signed, until
// the recipient collects it with a signed `inbox` statement. Reading never deletes;
// messages expire after 30 days, or sooner with `inbox-delete`.
//
// KV, all small:
//   mail:<to>:<id>             { id, from, to, subject, received, encrypted, statement, signature }
//                              expires after 30 days
//   mailbox:<to>               [{ id, expires }]: what's held, so collecting needs no list
//                              (KV lists lag new keys by up to a minute, and the free plan
//                              allows 1,000 a day); expires with the newest message
//   mailrate:<from>:<YYYY-MM-DD>   messages sent that day, for the per-sender limit

import { AGE_RE, lookupSection } from './timda1.mjs';
import { CONFIG } from './config.mjs';
import { HOST_RE, esc, readIndex, verifyStatement } from './hub.mjs';

export const MAIL_TTL = 30 * 24 * 3600; // TIMDA-3 §6: kept for 30 days
const { perSenderPerDay, perInbox } = CONFIG.mail;
const SUBJECT_MAX = 100;
const AGE_ARMOR = '-----BEGIN AGE ENCRYPTED FILE-----';

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
/** A message's ID: the first 10 hex characters of the SHA-256 of the signed statement (TIMDA-3 §6). */
export async function messageId(message) {
  return hex(await crypto.subtle.digest('SHA-256', message)).slice(0, 10);
}

/** A domain's mailbox: the IDs held for it, unexpired. Built by listing, once, if it's missing. */
async function mailbox(env, domain, now) {
  let box = await env.REGISTRY.get(`mailbox:${domain}`, 'json');
  if (!Array.isArray(box)) { // never collected since mailbox keys existed: look once, then keep it
    box = [];
    let cursor;
    do {
      const page = await env.REGISTRY.list({ prefix: `mail:${domain}:`, cursor });
      box.push(...page.keys.map((k) => ({ id: k.name.split(':').pop(), expires: new Date(now.getTime() + MAIL_TTL * 1000).toISOString() })));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    await saveMailbox(env, domain, box);
  }
  return box.filter((m) => m.expires > now.toISOString());
}
// Kept as long as its newest message (an empty one for 30 days, so it's never listed again).
async function saveMailbox(env, domain, box) {
  const last = box.length ? Math.max(...box.map((m) => Date.parse(m.expires))) : Date.now() + MAIL_TTL * 1000;
  return env.REGISTRY.put(`mailbox:${domain}`, JSON.stringify(box), { expiration: Math.ceil(last / 1000) + 60 });
}

/** Every message held for a domain, oldest first. */
export async function heldFor(env, domain, now = new Date()) {
  const box = await mailbox(env, domain, now);
  const mail = (await Promise.all(box.map((m) => env.REGISTRY.get(`mail:${domain}:${m.id}`, 'json')))).filter(Boolean);
  return mail.sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id));
}

/**
 * Take a signed statement for the relay: a message (held for its recipient), an inbox
 * read, or an inbox-delete. Returns { ok: true, type, … } or { ok: false, error }.
 */
export async function relay(env, args) {
  const v = await verifyStatement(env, args);
  if (!v.ok) return v;
  if (v.type === 'message') return accept(env, v, args);
  if (v.type === 'inbox') return { ok: true, type: v.type, from: v.from, mail: await heldFor(env, v.from, args.now) };
  if (v.type === 'inbox-delete') return remove(env, v, args.now);
  return { ok: false, error: `the relay takes message, inbox and inbox-delete statements, not ${v.type}` };
}

async function accept(env, v, { message, armored, hub, fetchImpl = fetch, now = new Date() }) {
  const to = (v.headers.get('to') ?? '').toLowerCase();
  if (!HOST_RE.test(to)) return { ok: false, error: 'to: must name the recipient\'s domain' };
  const subject = v.headers.get('subject') ?? '';
  if ([...subject].length > SUBJECT_MAX) return { ok: false, error: `subject: is over ${SUBJECT_MAX} characters` };
  if (!v.body.trim()) return { ok: false, error: 'the message has no body (a blank line, then the text)' };

  // This hub carries mail only between Sections it lists, and to and from itself
  // (CONFIG.mail.listedOnly); either way, both ends must have valid Sections.
  const index = await readIndex(env);
  const carried = (d) => d === hub || !CONFIG.mail.listedOnly || index.domains.includes(d);
  if (!carried(v.from)) return { ok: false, error: `${v.from} isn't docked and approved here, so this hub won't carry its mail` };
  if (!carried(to)) return { ok: false, error: `${to} isn't docked and approved here` };

  // The recipient's inbox, read live (TIMDA-3 §2).
  let r;
  try { r = await lookupSection(to, { fetchImpl, now }); } catch (e) { return { ok: false, error: `couldn't look ${to} up: ${e.message}` }; }
  if (r.status !== 'valid') return { ok: false, error: `${to} has no valid Section right now` };
  const inbox = r.section.inbox;
  if (!inbox) return { ok: false, error: `${to} has no inbox: it publishes no _inbox._timda record` };
  if (inbox.hub !== hub) return { ok: false, error: `${to}'s inbox is held at ${inbox.hub}, not here` };

  // Encryption (TIMDA-3 §5): to an inbox with an age key, only age ciphertext.
  const encrypted = v.headers.get('encrypted');
  if (encrypted !== undefined && encrypted !== 'age') return { ok: false, error: 'encrypted: may only be age' };
  if (inbox.age && AGE_RE.test(inbox.age)) {
    if (encrypted !== 'age' || !v.body.trimStart().startsWith(AGE_ARMOR)) {
      return { ok: false, error: `${to} takes encrypted mail only: encrypt the body with age -a -r ${inbox.age}, and add the header "encrypted: age"` };
    }
  } else if (encrypted === 'age') {
    return { ok: false, error: `${to} publishes no age key, so it couldn't read an encrypted message` };
  }

  // Limits, refused out loud rather than dropped (TIMDA-3 §6).
  const day = now.toISOString().slice(0, 10);
  const rateKey = `mailrate:${v.from}:${day}`;
  const sent = Number(await env.REGISTRY.get(rateKey)) || 0;
  if (sent >= perSenderPerDay) return { ok: false, error: `${v.from} has sent ${perSenderPerDay} messages today, this hub's limit; try again tomorrow (UTC)` };
  const box = await mailbox(env, to, now);
  if (box.length >= perInbox) return { ok: false, error: `${to}'s inbox is full (${perInbox} messages); it has to clear some first` };

  const id = await messageId(message);
  const received = now.toISOString();
  const record = {
    id, from: v.from, to, subject, received, encrypted: encrypted === 'age',
    statement: new TextDecoder().decode(message), signature: armored,
  };
  await env.REGISTRY.put(`mail:${to}:${id}`, JSON.stringify(record), { expirationTtl: MAIL_TTL });
  await saveMailbox(env, to, [...box.filter((m) => m.id !== id), { id, expires: new Date(now.getTime() + MAIL_TTL * 1000).toISOString() }]);
  await env.REGISTRY.put(rateKey, String(sent + 1), { expirationTtl: 2 * 24 * 3600 });
  return { ok: true, type: 'message', from: v.from, to, id, subject, encrypted: record.encrypted, hub };
}

async function remove(env, v, now = new Date()) {
  const spec = (v.headers.get('delete') ?? '').trim();
  if (!spec) return { ok: false, error: 'delete: needs message IDs, comma-separated, or all' };
  const held = await heldFor(env, v.from, now);
  const ids = spec === 'all' ? held.map((m) => m.id) : spec.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (ids.some((id) => !/^[0-9a-f]{10}$/.test(id))) return { ok: false, error: 'delete: message IDs are 10 hex characters' };
  const have = new Set(held.map((m) => m.id));
  const gone = ids.filter((id) => have.has(id));
  await Promise.all(gone.map((id) => env.REGISTRY.delete(`mail:${v.from}:${id}`)));
  if (gone.length) await saveMailbox(env, v.from, (await mailbox(env, v.from, now)).filter((m) => !gone.includes(m.id)));
  return { ok: true, type: 'inbox-delete', from: v.from, deleted: gone, missing: ids.filter((id) => !have.has(id)), left: held.length - gone.length };
}

// ---- rendering --------------------------------------------------------------------------

/** A bang path, the old UUCP way: sender!hub!recipient. */
export const bangPath = (...hops) => hops
  .filter((h, i) => h !== hops[i - 1]) // the hub's own mail: timda.space!section76.net
  .map(esc).join('<span class="bang">!</span><wbr>');

// Downloads without JavaScript: the exact bytes, as a data: link.
const utf8b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const download = (name, text, label) => `<a download="${esc(name)}" href="data:text/plain;charset=utf-8;base64,${utf8b64(text)}">${esc(label)}</a>`;

// Whether the hub could read it, at a glance: sealed (age) in the GOOD colour, open in amber.
const envelope = (sealed) => (sealed
  ? '<dd class="envelope envelope-sealed">Sealed (age)</dd>'
  : '<dd class="envelope envelope-open">Open: the hub can read it</dd>');

/** One held message, with what's needed to check it without trusting the hub. */
export function renderMail(m, hub) {
  const body = m.statement.split('\n\n').slice(1).join('\n\n');
  const text = m.encrypted
    ? `<p class="hint">Encrypted with age, so only the recipient can read it. ${download(`${m.id}.age`, body, `Save the ciphertext (${m.id}.age)`)}, then: <code>age -d -i &lt;your age key&gt; ${esc(m.id)}.age</code></p>`
    : `<pre class="mail-body">${esc(body)}</pre>`;
  return `<article class="mail" id="mail-${esc(m.id)}">
  <dl class="status-rows mail-head">
    <div><dt>Path</dt><dd>${bangPath(m.from, hub, m.to)}</dd></div>
    <div><dt>Envelope</dt>${envelope(m.encrypted)}</div>
    <div><dt>Subject</dt><dd>${m.subject ? esc(m.subject) : '(none)'}</dd></div>
    <div><dt>Received</dt><dd><time datetime="${esc(m.received)}">${esc(m.received.replace('T', ' ').slice(0, 16))} UTC</time></dd></div>
    <div><dt>Message ID</dt><dd><code>${esc(m.id)}</code></dd></div>
  </dl>
  ${text}
  <p class="mail-check">Check it yourself: ${download(`${m.id}.txt`, m.statement, `${m.id}.txt`)} and ${download(`${m.id}.txt.sig`, m.signature, `${m.id}.txt.sig`)}, then <code>timda signers ${esc(m.from)} &gt; signers &amp;&amp; ssh-keygen -Y verify -f signers -I ${esc(m.from)} -n timda -s ${esc(m.id)}.txt.sig &lt; ${esc(m.id)}.txt</code></p>
</article>`;
}

/** What the relay says back, as HTML for the mast page. */
export function renderRelay(r, hub) {
  const notice = (kind, html) => `<div class="notice notice-${kind}" role="status">${html}</div>`;
  if (!r.ok) return notice('crit', `<strong>Not transmitted.</strong> ${esc(r.error)}`);
  if (r.type === 'message') {
    const seal = r.encrypted
      ? ' <span class="envelope envelope-sealed">Sealed with age</span>: only the recipient can read it.'
      : ' <span class="envelope envelope-open">Not encrypted</span>: this hub can read it.';
    return notice(r.encrypted ? 'good' : 'warn', `<strong>Transmitted.</strong> ${bangPath(r.from, hub, r.to)}, message <code>${esc(r.id)}</code>${r.subject ? ` (&ldquo;${esc(r.subject)}&rdquo;)` : ''}. It's held for ${esc(r.to)} for 30 days, until they collect it.${seal}`);
  }
  if (r.type === 'inbox-delete') {
    const missing = r.missing.length ? ` Not found: ${r.missing.map((id) => `<code>${esc(id)}</code>`).join(', ')}.` : '';
    return notice('good', `<strong>Cleared.</strong> Deleted ${r.deleted.length} message${r.deleted.length === 1 ? '' : 's'} for ${esc(r.from)}; ${r.left} left.${missing}`);
  }
  if (!r.mail.length) return notice('good', `<strong>No mail</strong> for ${esc(r.from)}.`);
  return notice('good', `<strong>${r.mail.length} message${r.mail.length === 1 ? '' : 's'}</strong> for ${esc(r.from)}, oldest first. Each is kept for 30 days from arrival; reading doesn't delete it.`)
    + r.mail.map((m) => renderMail(m, hub)).join('\n');
}
