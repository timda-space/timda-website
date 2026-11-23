// timda-prune: keeps the newest N deployments of the Pages project and deletes the rest.
// Cloudflare keeps every Pages deployment live, with the code and bindings it was built
// with, so without this they pile up. A scheduled Worker (no public URL, no fetch handler).
//
// Per environment (production and preview separately) it keeps the newest KEEP deployments.
// It never deletes the project's current production deployment, nor its latest one,
// whatever their age. DRY_RUN defaults to on: it only logs what it would delete
// (see them with `npx wrangler tail`). Set DRY_RUN to "false" to delete for real.
//
// Needs a secret CF_API_TOKEN (scoped to Cloudflare Pages: Edit) and ACCOUNT_ID.

const API = 'https://api.cloudflare.com/client/v4';
const PAGE = 25;
const MAX_DELETES = 30; // Workers' free plan allows 50 subrequests per run; the rest waits for tomorrow

/** Which of these deployments (any order) should go? Keeps the newest `keep`, plus anything protected. */
export function pickDeletions(deployments, keep, protectedIds = []) {
  const safe = new Set(protectedIds.filter(Boolean));
  return [...deployments]
    .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
    .slice(Math.max(0, keep))
    .filter((d) => !safe.has(d.id));
}

async function call(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`${init.method || 'GET'} ${path}: ${res.status} ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  }
  return body;
}

async function listAll(env, base, environment, pages) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const { result = [] } = await call(env, `${base}/deployments?env=${environment}&page=${page}&per_page=${PAGE}`);
    out.push(...result);
    if (result.length < PAGE) break;
  }
  return out;
}

export async function prune(env, log = console.log) {
  const keep = Number.parseInt(env.KEEP ?? '10', 10);
  if (!Number.isInteger(keep) || keep < 3) throw new Error('KEEP must be a whole number, at least 3');
  const dry = String(env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  const base = `/accounts/${env.ACCOUNT_ID}/pages/projects/${env.PROJECT || 'timda-station'}`;

  const { result: project } = await call(env, base);
  const protectedIds = [project.canonical_deployment?.id, project.latest_deployment?.id];

  let budget = MAX_DELETES;
  const summary = {};
  for (const environment of ['production', 'preview']) {
    const all = await listAll(env, base, environment, 4); // newest 100 is plenty: the tail is what we trim
    const doomed = pickDeletions(all, keep, protectedIds).slice(0, budget);
    summary[environment] = { seen: all.length, deleting: doomed.length };
    for (const d of doomed) {
      log(`${dry ? 'would delete' : 'deleting'} ${environment} ${d.id} (${d.created_on})`);
      if (!dry) await call(env, `${base}/deployments/${d.id}?force=true`, { method: 'DELETE' });
    }
    budget -= doomed.length;
  }
  log(`timda-prune ${dry ? '(dry run) ' : ''}keep=${keep} ${JSON.stringify(summary)}`);
  return summary;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(prune(env));
  },
};
