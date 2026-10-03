# CLAUDE.md

Standing rules for any AI agent working in this repository. Read before making changes.

## What this repo is

Theme Park Co-Pilot — an AI theme-park trip-planning PWA.

- `app.html` — the entire client app, one large single file, served at `app.themeparkcopilot.com`
- `api/*.js` — Vercel serverless functions (project `disney-wait-times-lupt`)
- Blog and marketing site at `themeparkcopilot.com`, same Vercel project
- State lives in Vercel Blob. There is no database.

**This repository is public.** Anything committed here is world-readable.

## Hard rules

1. **Never commit secrets.** No API keys, passwords, tokens, trip codes, or admin keys
   in code, comments, docs, commit messages, or test fixtures. Read credentials from
   `process.env` only, and fail closed when unset. Never write
   `process.env.X || 'some-literal-fallback'` — a burned key survived two months in
   four files that way.
2. **ESM only.** `import` / `export default`. Never `require` / `module.exports`.
3. **ASCII-only strings** in API code.
4. **Never merge to `main`.** Work on a branch, push, and stop. The repo owner reviews
   and merges. Do not open-and-merge your own pull request.
5. **Never commit personal or trip-specific data** — no family names, travel dates, or
   trip codes in source.

## Before you commit

- Run `node --check` on every changed `.js` file. `package.json` sets `"type": "module"`,
  so these are ES modules.
- Read the full `git diff`. Confirm only the intended files and hunks changed.
- Do not commit `package.json` or lockfile changes unless that is explicitly the task.

## Vercel Blob (`@vercel/blob` 2.x)

Two 2.x behaviors have each taken production down. Both are easy to reintroduce.

**Reads must be suffix-tolerant.** `list({ prefix })` returns *every* historical suffixed
blob under a prefix, because legacy `addRandomSuffix` writes accumulated one blob per
edit. Never select with `b.pathname === key` — an exact match can latch onto a stale
blob. Use a `matchesKey(pathname, key)` predicate (matches bare `key`, or
`key + '-' + alphanumeric-only-suffix`, rejecting longer sibling slugs), select the
newest by `uploadedAt`, and guard for `blobs.length > 0`.

**Writes to fixed keys need `allowOverwrite: true`.** Under 2.x, `put()` throws when the
pathname already exists.

Trip-data blob paths carry a secret path segment from the `BLOB_PATH_SALT` env var.
Never log or return a resolved blob pathname.

## The intelligence cache

Two blobs: `park_intel_dl_stable` (monthly) and `park_intel_dl_dynamic` (weekly). Each
AI endpoint injects only the sections it needs.

- The correct read path is `.data.sections` — not `.sections`.
- **A requested section that does not exist coerces to an empty string, silently.**
  Before adding a name to a selector array, confirm the cache actually contains that
  section. Before removing a section from the cache, confirm nothing selects it.
- After changing `ai.js`, `reoptimize.js`, or `generateschedule.js`, check the Vercel log
  for `cache_sections:` and confirm real section names appear. An empty array means the
  cache is broken no matter what the code looks like.

## API endpoint conventions

- JWT verification is the **first** operation in every protected endpoint.
- Every new endpoint needs rate limiting, JWT verification, and security headers.
- Never expose the Anthropic API key client-side. The model choice is hardcoded
  server-side.

## Client (`app.html`)

- One enormous single file. Make surgical, targeted edits. Never regenerate it wholesale.
- **No emoji anywhere in the UI.** SVG icons only.
- Coral `#C86030` is reserved exclusively for the AI Optimize call-to-action. Using it
  elsewhere destroys the signal.
- Brand fonts are Outfit and Fraunces. Never recreate, redraw, or approximate the logo —
  reference the hosted asset.
- **All visual QA happens at 390px viewport width.** A desktop-only check is not a check.

## Failure modes this codebase has actually hit

Design against these specifically.

- **Silent success.** A cron returned HTTP 200 with `ok:true` while rebuilding nothing
  for fourteen weeks; the dashboard showed a green run every time. Return a non-2xx on
  failure and log what failed by name.
- **Count guards are not presence checks.** A `sectionCount < 6` threshold passes
  comfortably while three specifically-named sections are missing.
- **Work computed, then discarded.** Data has been collected and never written through,
  and server-side corrections have been computed and then ignored by a client that
  re-parsed the raw text. Trace the full path from collection to actual use.
- **Prompt instructions are probabilistic.** Enforce physical constraints in code
  (correct park, one dinner per day, activities inside park hours). Leave strategy to the
  model and the cache (hop timing, ride order, what to rope-drop).

## Capacitor native shell (Oct 2026)

- The iOS app is a Capacitor shell loading `index.html` (built from `app.html` via
  `scripts/build-capacitor-www.mjs`). Any client-side navigation to `app.html`
  404s in the shell — use protocol-aware URLs: `capacitor:` protocol → `index.html`,
  otherwise `app.html`.
- The iOS simulator cannot reach `disney-wait-times-lupt.vercel.app` (hangs
  indefinitely; Mac Safari/Terminal reach it fine). All API calls use
  `https://app.themeparkcopilot.com`. Do not reintroduce the old host.
- Add `AbortController` timeouts to every fetch: 15s for reads/writes, 65s for
  schedule generation POSTs. A hung request freezes the WebView with no error.

## Trip code auth (Oct 2026)

- Trip codes are validated against the registry, not by shape. `_isRegisteredTripCode`
  in `/api/generateschedule`, `/api/ai`, `/api/dining`, and `/api/reoptimize` reads
  the trip registry (same salted-first/bare-fallback as `api/trip.js`, 60s in-memory
  cache) and accepts only codes that were actually issued. Admin key still bypasses.
  (History: shape-only checks — ≥8 chars, then ≥6 from Oct 1 for BEAU01 — let anyone
  invent a code; retired Oct 3, 2026.)

## Web app retired (Oct 3, 2026)

- Native app only. The web app pages are NOT publicly served: vercel.json redirects
  `/app.html`, `/pretrip.html`, `/manifest.json`, `/sw.js` (all hosts) to
  `/api/not-found` (404); on `app.themeparkcopilot.com` and the legacy
  `disney-wait-times-lupt.vercel.app` host, `/` redirects to the marketing site and a
  host catch-all 404s everything else. `/api/*` is unaffected (functions, not files).
  `disney-trip-planner.html` was deleted. Blog, teaser, and `/admin` on the apex are
  untouched. If universal links are ever added, carve out `/.well-known/*` BEFORE the
  host catch-alls. There is NO Vercel Firewall config on this project (verified
  Oct 3, 2026) — rate limiting is in-code per-IP caps plus the Anthropic spend cap.

## GitHub Contents API stale reads (Oct 2026)

- GET after PUT can return the pre-PUT file version. Download-edit-push in quick
  succession silently reverts the previous commit. Mitigations: sleep 10s+ before
  GET, verify the download contains the prior commit's changes, batch edits into
  one push, and GET-verify with `?ref=<sha>` after pushing.
