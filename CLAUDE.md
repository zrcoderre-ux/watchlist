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
  scores from OMDb (`/api/ratings/<imdb id>`), kept for good in the
  `ScoreStore` Durable Object and re-asked of OMDb only after 14 days for a
  title from this year or last, 180 for older ones (the free key allows 1,000
  lookups a day). If OMDb refuses, stored scores are served however old.
  Once OMDb says the day's limit is reached, the server asks it nothing more
  until the next UTC day (`limitedDay`) and answers 429 with `paused` and
  `retryAfter`; the app then stops asking too (`ratingsPausedUntil`).
  Background filling (`?bg=1`, from `refreshStaleDetails`) stops at
  `OMDB_BACKGROUND_SHARE` (700) a day, keeping the rest for what's on screen.
  Every outgoing Claude, OMDb and TMDB call is counted by UTC day in the
  `UsageStore` Durable Object (`/api/usage`, shown in Settings → Usage);
  Claude's cost is estimated from `CLAUDE_PRICES` in `worker.js` (update it
  when prices or the model change) and filed under the `feature` that
  `askClaude()` passes. Claude stops for the day once that estimate reaches
  `CLAUDE_DAILY_CAP` ($5): `/api/jobs` answers 429 with `paused: 'claude'`
  and `retryAfter` (the app stops making "For you" ahead, `claudePausedUntil`),
  and a running job stops between pieces. A job records its Claude usage once per alarm, not per
  call, to stay inside the 50-requests-per-invocation limit.
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
  and OMDb scores (`ratings`, re-checked with the server monthly), which cards
  and rows show as "RT 83% · MC 73" (`criticsText`). Scores are looked up for
  the top two Discover cards, the watchlist and the titles rated liked or
  loved (in `refreshStaleDetails`), "For you" picks and opened titles — never
  for a whole list at once.
- Genre balance (`// ── Taste ───`): a small logistic model, refit when
  `itemsVersion` changes, learns from the last 500 keeps and passes how each
  genre (plus Anime, i.e. Japanese animation) moves the odds of keeping a
  title. Discover thins TMDB's lists by it and "For you" tells Claude about
  it. No title's chance goes below `TASTE_FLOOR`; never let it reach zero.
  Each page Trending, Top rated and New fetch is then ordered by `deckRank()`:
  reviews out of 10 (RT, else the blend, TMDB's rating shrunk toward
  `DECK_REVIEW_PRIOR` on few votes) plus `DECK_TASTE_PULL` × the genre pull.
  Pages stay in TMDB's order; only the order within one changes.
  Every list, For you included, hides panned titles (`panned()`): Rotten
  (under `PANNED_RT`) where RT has a score, else a blend under
  `PANNED_SCORE`. The next four cards' scores are looked up so a Rotten one
  goes before it reaches the top.
- "For you" keeps only titles that clear a floor, unless Claude marks the pick
  `strongMatch`: Rotten Tomatoes critics where OMDb has a score (looked up per
  pick), otherwise `blendedScore()`: the average of TMDB's audience (on at
  least `AI_MIN_VOTES` votes), IMDb and Metacritic as tenths, whichever a
  title has, Metacritic weighted `AI_CRITICS_WEIGHT` (1.5). The floor
  moves (`aiFloors()`): once `AI_FLOOR_SAMPLE` liked or loved titles have a
  score, it sits just under the lower quartile of theirs (a loved title
  counting `AI_FLOOR_LOVED_WEIGHT` times; RT −3, blended −0.2),
  within `AI_FLOOR_RT` / `AI_FLOOR_SCORE`; until then 80% / 8.0. Claude is
  told the floor; the app enforces it.
- "For you" is made ahead: `topUpAi()` keeps `AI_READY` (3) batches waiting
  in `aiQueue` (`wl.aiQueue`, kept `AI_READY_DAYS`) for the filters last used
  with "For you" (`wl.aiFilters`), one request at a time, each told what's
  already waiting so it doesn't repeat it. Besides the taste profile, each
  request lists every other seen or watchlisted title tersely, so no pick is
  spent on one (older passes are left out on purpose). Tapping "For you" takes the oldest
  batch at once and tops up behind it. Requests in flight live in `aiRuns`
  (by filter set); one still running at a reload is collected from its job id
  (`wl.aiPending`). If the person had to wait and left, the chip shows a dot
  and a toast says when the picks are ready.
- Recommendations default to the person's services: Discover's "My services"
  (`deckMineSet`) and Tonight's switch (`wl.tonightMine`) are on whenever
  services are picked, until the person flips them; only a flipped choice is
  saved.
- The watchlist can run to hundreds of rows: background updates call
  `wlTouch(key)` to redraw that row or slide in place (`wlRowInner` /
  `wlSlideInner`), never a full `renderWatchlist()`, unless "My services" or
  the runtime sort makes membership or order depend on the update; then the
  rebuild waits for scrolling to stop. Rows use `content-visibility: auto`.
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
