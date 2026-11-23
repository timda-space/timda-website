// The mast's record planner: timda plan in the browser. Fill in a form, get the
// exact TXT records back in several formats (any DNS host, not just Cloudflare),
// already checked. No JavaScript: the form posts, the hub renders.

import { AGE_RE, HOST_RE, PARTS, assembleSection, planRecords, recordKeyFromSshPublicKey, renderPlan, sectionChecks } from './timda1.mjs';
import { esc } from './hub.mjs';

const STATUSES = ['open', 'pending', 'closed'];
const LINK_FIELDS = ['airlock', 'charter', 'setting', 'button', 'banner'];
export const FORMATS = [
  ['table', 'Table: for any DNS host’s web dashboard', true],
  ['zone', 'Zone file: import into most DNS hosts', false],
  ['cloudflare', 'OpenTofu / Terraform: Cloudflare', false],
  ['route53', 'OpenTofu / Terraform: AWS Route 53', false],
];

/** Read the planner form into clean values (strings, trimmed). */
export function plannerValues(form) {
  const get = (k) => String(form.get(k) ?? '').trim();
  const v = { domain: get('domain').toLowerCase().replace(/^https?:\/\//, '').replace(/[/].*$/, '').replace(/\.$/, ''), name: get('name'), status: get('status') || 'pending', concept: get('concept'), keys: get('keys'), caption: get('caption'), inbox: get('inbox').toLowerCase(), age: get('age'), ttl: get('ttl') || '300' };
  for (const f of LINK_FIELDS) v[f] = get(f);
  return v;
}

/** Turn pasted keys (lines from .pub files, or record values) into key record values. */
function keyValues(text) {
  const keys = [];
  const errors = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (/^(sk-)?ed25519:/.test(line)) { keys.push(line); continue; }
    try { keys.push(recordKeyFromSshPublicKey(line)); } catch (e) { errors.push(`key ${JSON.stringify(line.slice(0, 40))}…: ${e.message}`); }
  }
  return { keys, errors };
}

/**
 * Plan a Section's records from the form values. Returns { checks, plan? }: checks are
 * GOOD/WARN/CRIT like the beacon test; plan is there when the records would be valid.
 */
export function planFromValues(v) {
  const checks = [];
  if (!HOST_RE.test(v.domain)) return { checks: [['CRIT', v.domain ? `not a domain name: ${v.domain}` : 'enter your domain, like section72.net']] };
  if (!STATUSES.includes(v.status)) return { checks: [['CRIT', 'status must be open, pending or closed']] };
  const ttl = Number(v.ttl);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) return { checks: [['CRIT', 'TTL must be a whole number of seconds, 60 to 86400 (300 is good)']] };
  const { keys, errors } = keyValues(v.keys);
  for (const e of errors) checks.push(['CRIT', e]);
  if (!keys.length && !errors.length) checks.push(['CRIT', 'paste at least one public key (the line from your .pub file)']);

  const opts = { name: v.name, status: v.status, concept: v.concept || undefined, keys, ttl, caption: v.caption || undefined };
  for (const f of LINK_FIELDS) if (v[f]) opts[f] = v[f];
  if (opts.caption && !opts.banner) checks.push(['WARN', 'a caption only goes with a banner; it was left out']);
  if (v.inbox) {
    if (!HOST_RE.test(v.inbox)) checks.push(['CRIT', `inbox hub: not a domain name: ${v.inbox}`]);
    else opts.inbox = v.inbox;
    if (v.age && !AGE_RE.test(v.age)) checks.push(['CRIT', 'age key: expected an age public key (age1…, from age-keygen)']);
    else if (v.age) opts.age = v.age;
  } else if (v.age) checks.push(['WARN', 'an age key only goes with an inbox; it was left out']);
  const plan = planRecords(v.domain, opts);

  // Check exactly what would be published, the way a hub will read it.
  const byName = Object.fromEntries(Object.entries(PARTS).map(([part, prefix]) => [`${prefix}.${plan.domain}`, part]));
  const found = {};
  for (const { name, content } of plan.records) (found[byName[name]] ??= []).push(content);
  const result = assembleSection(plan.domain, found);
  checks.push(...sectionChecks(result)); // no DNSSEC or images: nothing's published yet
  if (ttl > 3600) checks.push(['WARN', 'TTLs over an hour make changes slow to show; 300 seconds is recommended']);
  const ok = result.status === 'valid' && !checks.some(([l]) => l === 'CRIT');
  return { checks, plan: ok ? plan : undefined };
}

/** The planner form, filled in with the last values so mistakes are easy to fix. */
export function renderPlannerForm(v = {}) {
  const val = (k, d = '') => esc(v[k] ?? d);
  const text = (k, label, hint, ph = '') => `<p><label>${label}${hint ? ` <span class="hint">(${hint})</span>` : ''}<br><input type="text" name="${k}" value="${val(k)}" placeholder="${esc(ph)}" autocomplete="off" autocapitalize="none" spellcheck="false"></label></p>`;
  return [
    '<form class="dock planner" method="post" action="/econopod/planner#record-planner">',
    text('domain', 'Domain', 'required', 'section72.net'),
    text('name', 'Name', 'required, up to 48 characters', 'Section 72'),
    `<p><label>Status<br><select name="status">${STATUSES.map((s) => `<option${(v.status ?? 'pending') === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label> <span class="hint">pending while you set up; open to be linked</span></p>`,
    text('concept', 'Concept', 'optional, up to 120 characters', 'The 90s in the future'),
    `<p><label>Public keys <span class="hint">(one per line: the whole line from your .pub file)</span><br><textarea name="keys" rows="3" spellcheck="false" placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…">${val('keys')}</textarea></label></p>`,
    '<details class="rollup planner-more"><summary><h3>Optional links and inbox</h3></summary>',
    text('airlock', 'Airlock', 'where visitors land; your homepage if empty', 'https://section72.net/airlock'),
    text('charter', 'Charter', 'your rules', 'https://section72.net/charter'),
    text('setting', 'Setting', 'your lore; may be anywhere', 'https://section72.net/setting'),
    text('button', '88×31 button', 'PNG or GIF on your domain', 'https://section72.net/88x31.png'),
    text('banner', '468×60 banner', 'PNG or GIF on your domain', 'https://section72.net/468x60.png'),
    text('caption', 'Banner caption', 'up to 140 characters', 'The 90s, in the future.'),
    text('inbox', 'Inbox hub', 'take signed mail through this hub (the Wormhole Post)', 'timda.space'),
    text('age', 'Inbox age key', 'optional: mail is encrypted to it; from age-keygen', 'age1…'),
    text('ttl', 'TTL', 'seconds; 300 is good', '300'),
    '</details>',
    '<p><button type="submit">Plan my records</button></p>',
    '</form>',
  ].join('\n');
}

/** The planned records in every format, each in its own roll-up. */
export function renderPlanFormats(plan) {
  return FORMATS.map(([format, label, open]) => [
    `<details class="rollup plan-format"${open ? ' open' : ''}><summary><h3>${esc(label)}</h3></summary>`,
    `<pre tabindex="0"><code>${esc(renderPlan(plan, format))}</code></pre>`,
    '</details>',
  ].join('\n')).join('\n');
}
