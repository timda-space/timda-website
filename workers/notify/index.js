// timda-notify: emails the hub's operator. Pages Functions can't send email, so the
// hub calls this Worker through a service binding (NOTIFY). It has no public URL
// (workers_dev = false), and it only ever writes to one address, the TO variable, which
// must be a verified Email Routing destination (those sends are free, on any plan).
//
// It uses Email Routing's EmailMessage API (a raw message), which sends to verified
// destinations without onboarding a sending domain.

import { EmailMessage } from 'cloudflare:email';

/** RFC 2047: a header value that may not be plain ASCII. */
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);

/** The whole message, headers and plain-text body, as RFC 5322 text. */
export function rawMessage({ from, to, subject, text, date = new Date(), id = crypto.randomUUID() }) {
  return [
    `From: TIMDA Board <${from}>`,
    `To: ${to}`,
    `Subject: ${header(subject.replace(/[\r\n]+/g, ' ').slice(0, 200))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${id}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text.slice(0, 16384).replace(/\r?\n/g, '\r\n'),
  ].join('\r\n');
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST only\n', { status: 405 });
    let msg;
    try { msg = await request.json(); } catch { return new Response('expected JSON\n', { status: 400 }); }
    if (typeof msg?.subject !== 'string' || typeof msg?.text !== 'string') return new Response('expected {subject, text}\n', { status: 400 });
    const from = env.FROM.trim();
    const to = env.TO.trim();
    await env.EMAIL.send(new EmailMessage(from, to, rawMessage({ from, to, subject: msg.subject, text: msg.text })));
    return new Response('sent\n');
  },
};
