# AGENTS.md

Guidance for anyone (human or AI agent) working in this repo.

## What TIMDA is

TIMDA (Technocratic Incorporated Multi-node Digital Astrodrome) is a retro-futurist space-station webring hub. Sites ("Sections") opt in with DNS TXT records under `_timda`, identify only by domain + SSH public key, and sign statements with `ssh-keygen -Y sign -n timda`.

Principles. Don't break these:

- **Everything is opt-in.** Nobody is pulled into any part of it.
- **Sections never have to name a person.** Identity is domain + key.
- **No accounts.**
- **No JavaScript sent to browsers.** Functions run at Cloudflare, never in the visitor's browser.
- **No sticky state**, except a hub's editorial delisting.

**Sections are anonymous; the project isn't. Contribute under your own account.**

## This repo

`timda-space/timda-website`: the hub, served at `timda.space` from Cloudflare Pages (project `timda-station`) plus Pages Functions. Specs, docs, infra and the `timda` CLI live in `timda-space/timda.space`. See `README.md` for the full layout and routes.

| Path | What |
| --- | --- |
| `pages/` | Page sources: edit these. `places.json`, `_layout.html`, one file per place. |
| `public/` | What gets deployed. The `.html` files are generated; **commit the built output.** |
| `hub/*.mjs` | The hub's logic, with tests |
| `functions/` | Thin Pages Functions wrappers around `hub/routes.mjs` |
| `workers/notify/` | The `timda-notify` Worker (Email Routing) that sends review emails |
| `workers/prune/` | The `timda-prune` scheduled Worker that keeps the newest 10 Pages deployments per environment (dry run until `DRY_RUN` is `"false"`) |
| `specs/`, `hub/timda1.mjs`, `hub/sshsig.mjs` | **Vendored copies** of timda.space's originals. Change them there, not here; a drift test fails if they differ. |

Cloudflare bindings: `REGISTRY` (KV: `timda-registry` in production, `timda-registry-staging` in preview) and `NOTIFY` (service binding to `timda-notify`). No build command; output directory `public`. Every host except `timda.space` shows a STAGING/PREVIEW bar.

Licences: code AGPL-3.0 (`LICENSE`), site content CC BY 4.0 (`LICENSE-content`).

## Build and test

```console
$ node tools/build.mjs                                   # pages/ + specs/ -> public/ (commit the result)
$ node tools/render-map.mjs && node tools/build.mjs      # after editing map/ or places.json
$ node --test hub/*.test.mjs tools/*.test.mjs            # 34 tests
```

Tests need `timda.space` checked out alongside this repo as `../timda.space` (for the drift tests), and `age` installed (for the sealed-mail tests). CI does the same and also checks that `public/` matches a fresh build.

## Workflow

- Branches: `main` (production) and `staging` (served at `staging.timda.space`).
- Work goes by pull request into `staging`, gets tried on staging, then a release PR `staging` -> `main`.
- **Never merge PRs yourself.** The maintainer merges.
- **Never force-push.** Never delete `staging`.
- Keep personal details (real names, email addresses) out of files and commit messages.
- Run `node tools/build.mjs` before committing page changes.
