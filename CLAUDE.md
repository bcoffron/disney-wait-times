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
  host catch-alls. The Vercel Firewall rate-limit rules are ACTIVE on this project: "Rate limit AI
  and scheduling endpoints" (5 AI paths, 20/60s per IP, deny 403 for 5 min; built
  July 15, 2026) and "Rate limit trip writes" (POST/PUT /api/trip; added Sept 29,
  2026). The AI rule was verified enforcing Oct 3, 2026 (single-connection probe:
  20x 401 then 403 from #21). Two traps for future investigators: (1) the Vercel
  API/connector read (get_firewall_config) returns a SPURIOUS "Seawall Config not
  found" 404 for this project even though the rules exist — the dashboard is
  ground truth, never conclude absence from that API; (2) rate-limit probes must
  run over ONE connection (a single curl invocation with the URL repeated) —
  separate requests from a rotating-IP egress never accumulate a per-IP count.
  An hourly watchdog cron (tpcp-firewall-watchdog) runs that probe and alerts
  only on failure. Rule 2's effective threshold is unverified: it did not trip
  at 35 rapid writes in Oct 3 testing despite the recorded 30/60s spec — check
  its parameters in the dashboard before relying on the number. Keep firewall
  rules narrowly scoped: the app polls /api/waittimes and /api/vipnotes
  constantly and households share NAT IPs — never blanket-limit /api/*.

## GitHub Contents API stale reads (Oct 2026)

- GET after PUT can return the pre-PUT file version. Download-edit-push in quick
  succession silently reverts the previous commit. Mitigations: sleep 10s+ before
  GET, verify the download contains the prior commit's changes, batch edits into
  one push, and GET-verify with `?ref=<sha>` after pushing.

## Schedule-quality overhaul (Oct 4, 2026)

First device run of the native app exposed a broken Day 1 (Beau's report): content
rendered under the Dynamic Island, only 3 day tabs with Day 2 black, Space Mountain
mislabeled as a Single Pass, skipped/water rides present despite the onboarding
picks, snack/restroom/lunch clustered within ~an hour, cloned ride times across
days, and days ending ~8:30 PM with no evening show. Root causes and fixes:

- **Preference fields must be wired at FOUR points or they silently vanish**:
  `ptCollectData` (pretrip.html), `ptRestoreFromConfig` + `ptLoadFromStorage`,
  the generation payload in `ptGenerateDaySchedule`, and the generator's consume
  side. `avoidWater` failed at all four (hardcoded false in collect, stripped
  from the payload, read nowhere server-side). `ridePreferences`/`showPreferences`
  in Beau's stored BEAU01 config were empty — the Oct 4 trip was generated with
  NO preferences. After this fix a fresh setup pass persists them.
- **Generator (api/generateschedule.js)**: `buildCacheContext` now populates
  PARK_HOURS from the `park_hours_intel` blob (flat {dl,dca} shape; the stable/
  dynamic blobs have NO PARK_HOURS section — the old fallback closed DL at
  11 PM). The dynamic blob's TRIP_CONTEXT belongs to ONE trip (Jun 28–30, 2026,
  BCDIS2026) and is dropped unless the trip overlaps those dates.
  `avoidWater=true` folds Tiana's Bayou Adventure + Grizzly River Run into the
  skip set. `_priorRides`, prior venues (`tripConfig.dining.usedVenues`), wanted/
  skipped shows, and the SHOWS / SHOW_AND_ENTERTAINMENT sections are all passed
  into the scaffold fill/verify/backfill layers.
- **Scaffold (api/scaffold.js)**: park/land names are failed fills for dining/
  snack/show/ride/tip slots (deterministic backfill supplies a real venue/show/
  ride). ILL ground truth: only Rise of the Resistance + Radiator Springs Racers
  are Single Pass at this resort; bogus `ll:'single'` is downgraded and tip text
  scrubbed. Squash-key dedupe (normName minus spaces) + catalog canonicalization
  catches respelled duplicates ("WEB SLINGERS" vs "Webslingers"). Show slots:
  the show window no longer inverts on midnight closes (DL evenings get a show
  slot), a show card may only name a show that plays in the slot's park
  (`wrong-park-show`; wanted shows preferred only in-park), and headings are
  canonicalized to the official name ("World of Color - Happiness!"). Dining
  fills may not repeat a venue from an earlier day. Comfort spacing: break cards
  are nudged >=25 min after a previous break/snack/meal.
- **Client**: app.html viewport meta fixed (`device-width`, `viewport-fit=cover`)
  + safe-area-inset-top on the header; day tabs are created dynamically
  (`ensureDayTabs`) — the old file had exactly 3 hardcoded tabs, and a CSS rule
  hardcoded the VIP gold gradient to `#day-tab-2.active` (the black Day 2 tab).
  pretrip.html `_ptBuildParkHours` accepts the flat hours shape; `_genDaySeq`
  threads real prior-day ride names (was `[]` placeholders — the actual cause of
  cloned cross-day ride times). app.html's in-app regenerate path still does NOT
  set `scaffold:true` (known inconsistency, parked).
- **Acceptance (Oct 4, live API, BEAU01-shaped payloads)**: Day 1 — Space
  Mountain rope-drop 8:05 AM with ll=multi, no skipped/water rides, real venues,
  World of Color 8:00 PM finale. Day 2 (Day 1 rides threaded as _priorRides) —
  zero ride repeats, zero venue repeats, Web Slingers once, Grizzly proposed by
  the model and auto-removed by param enforcement, Fantasmic! 10:00 PM, last
  ride 11:15 PM. Commits: fceea4b8, 27da7e25, fc291aab, f336f99b (server),
  e496af16 (pretrip), 1cca9e00 (app), d9c11eba (validate-schedule), 228cf82a,
  baac3450, ed7f52ce, 9f567567, 9f003524, a614df27, f8d89304.
