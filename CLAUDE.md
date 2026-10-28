# Watchlist: working notes for Claude

## Workflow

**Merge automatically once a change is done.** When a change is finished and
verified, don't stop at "pushed, ready for review": open the pull request,
squash-merge it to `main`, and say so. No approval round-trip is expected.

1. Commit the work on a feature branch and push it.
2. Open a PR describing the change.
3. Squash-merge it.
4. Report what was merged and what it does.

A merge is a release: `main` deploys through Cloudflare's Git integration.
There is no CI workflow to wait on.

Ask first (don't auto-merge) when a change would delete or rewrite user data
(the synced list, the stored format of `items`), touch the passcode gate or
how secrets are handled, or when the task was ambiguous enough that the
wrong reading would be expensive to undo.

## Layout

The app is a single-file PWA. There is no build step: edit and ship.

- `index.html` — the whole app: markup, CSS, and the inline `<script>` holding
  all state and logic.
- `sw.js` — service worker, network-first so a reload always gets fresh code.
  It never caches `/api/`.
- `worker.js` — Cloudflare Worker: serves the static files, proxies TMDB
  (`/api/tmdb/…`, read-only, allow-listed paths, edge-cached), runs Claude
  jobs (`/api/jobs`, the model and key fixed server-side), and holds the list
  in the `WatchStore` Durable Object (`/api/sync`). With the optional
  `OMDB_KEY` it also returns a title's Rotten Tomatoes, IMDb and Metacritic
  scores from OMDb (`/api/ratings/<imdb id>`, edge-cached a day); the app asks
  only when a title's sheet opens, since the free key allows 1,000 a day.
  Every `/api/` call is gated by the `X-App-Key` passcode. See `SETUP.md`.
- Claude jobs: each runs in its own `ClaudeJob` Durable Object, driven by
  alarms, so it finishes when a phone suspends the app; the app polls
  `/api/jobs/<id>`. Long lists are read in pieces, and title lookups on TMDB
  run in slices of at most 40 outside requests per alarm (the free plan
  allows 50 per invocation). An import's job id is kept in
  `wl.pendingImport` until its result is shown, so reopening the app resumes
  it.
- `manifest.json`, `icon-*.png`, `apple-touch-icon.png` — PWA install metadata.

## Data

- `items` maps `"movie:603"` / `"tv:1396"` to a record with `status`
  (`want`, `watched`, `pass`, `none` after an undo), `myRating` (2 loved,
  1 liked, -1 not for me) and `updatedAt`. Every change goes through
  `setItem()`, which marks the key dirty and schedules a sync.
- Sync sends the dirty records and pulls everything the server saw change
  since `lastSync`; newer `updatedAt` wins on both sides. Records are never
  deleted, only re-statused, so a removal syncs like any other edit.
- `details` is a per-device cache of TMDB details and where a title streams,
  refreshed after 3 days. It is not synced. It also holds each title's IMDb id
  and OMDb scores (`ratings`), which cards and rows show as "RT 83% · MC 73"
  (`criticsText`). Scores are looked up for the top two Discover cards, the
  watchlist (in `refreshStaleDetails`), "For you" picks and opened titles —
  never for a whole list at once, since each is an OMDb call.
- Genre balance (`// ── Taste ───`): a small logistic model, refit when
  `itemsVersion` changes, learns from the last 500 keeps and passes how each
  genre (plus Anime, i.e. Japanese animation) moves the odds of keeping a
  title. Discover thins TMDB's lists by it and "For you" tells Claude about
  it. No title's chance goes below `TASTE_FLOOR`; never let it reach zero.
- "For you" keeps only titles that clear a bar, unless Claude marks the pick
  `strongMatch`: Rotten Tomatoes critics at `AI_MIN_RT` (80%) or more where
  OMDb has a score (looked up per pick, so up to 20 OMDb calls a tap),
  otherwise TMDB's audience at `AI_MIN_SCORE` (8) or more on at least
  `AI_MIN_VOTES` votes. Claude is told the bar; the app enforces it.
- A "For you" request lives in `aiRun`, keyed by the filters it was asked
  with, not in the deck: switching lists leaves it running, and its picks wait
  (dot on the chip, a toast) until "For you" is chosen again with the same
  filters. It isn't kept across a reload.
- One person, one list: plain `localStorage` keys prefixed `wl.`. Wrap every
  access in try/catch (`lsGet` / `lsSet`) — Safari private mode throws.

## Conventions

- Vanilla JS only. No frameworks, no bundler, no npm dependencies. The Worker
  calls the Claude API with `fetch` for the same reason.
- State lives in module-scoped `let` bindings at the top of the script; the
  section banner comments (`// ── State ───`) mark the boundaries — keep new
  code in the section it belongs to.
- Escape anything from TMDB, Claude, or the person with `esc()` before it
  reaches `innerHTML`.
- Claude calls go through `askClaude()` with a JSON schema; prompts stay in
  `index.html` next to the feature that uses them. Pass `resolve` to have the
  server match the titles in Claude's answer on TMDB (`matchToTitle()`).
- Styling follows Material 3: colour roles are defined on `:root` and
  redefined in the dark-scheme block — use the roles, never raw hex (text over
  a poster uses `--on-poster` in both schemes). Icons are Material Symbols:
  inline `<svg class="mi">` in markup, `icon(name)` in script.
- The layout is a phone column below 840px wide (framed from 600px). From
  840px a navigation rail replaces the bottom bar; all wide-screen overrides
  live in the `/* ── Wide screens ── */` block at the end of the stylesheet.
  Phones must not change when that block does.
- Credit TMDB, JustWatch and OMDb wherever their data is shown (Settings → About
  carries TMDB's required notice).
- Bump `APP_VERSION` in `index.html` with every user-visible change, and the
  `CACHE_NAME` in `sw.js` when cached files change.

## Verifying a change

There's no test suite. Run the Worker locally (`npx wrangler dev`, secrets in
`.dev.vars`) and drive it in a headless browser, at a phone width (390px) and
a desktop one (1440px), in both colour schemes. The app's functions are all
global, so they can be exercised from page context.
