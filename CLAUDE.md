# Watchlist: working notes for Claude

## Layout

The app is a single-file PWA. There is no build step: edit and ship.

- `index.html` — the whole app: markup, CSS, and the inline `<script>` holding
  all state and logic.
- `sw.js` — service worker, network-first so a reload always gets fresh code.
  It never caches `/api/`.
- `worker.js` — Cloudflare Worker: serves the static files, proxies TMDB
  (`/api/tmdb/…`, read-only, allow-listed paths, edge-cached), proxies Claude
  (`/api/claude`, the model and key fixed server-side), and holds the list in
  the `WatchStore` Durable Object (`/api/sync`). Every `/api/` call is gated
  by the `X-App-Key` passcode. See `SETUP.md`.
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
  refreshed after 3 days. It is not synced.
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
  `index.html` next to the feature that uses them.
- Styling follows Material 3: colour roles are defined on `:root` and
  redefined in the dark-scheme block — use the roles, never raw hex (text over
  a poster uses `--on-poster` in both schemes). Icons are Material Symbols:
  inline `<svg class="mi">` in markup, `icon(name)` in script.
- The layout is a phone column below 840px wide (framed from 600px). From
  840px a navigation rail replaces the bottom bar; all wide-screen overrides
  live in the `/* ── Wide screens ── */` block at the end of the stylesheet.
  Phones must not change when that block does.
- Credit TMDB and JustWatch wherever their data is shown (Settings → About
  carries TMDB's required notice).
- Bump `APP_VERSION` in `index.html` with every user-visible change, and the
  `CACHE_NAME` in `sw.js` when cached files change.

## Verifying a change

There's no test suite. Run the Worker locally (`npx wrangler dev`, secrets in
`.dev.vars`) and drive it in a headless browser, at a phone width (390px) and
a desktop one (1440px), in both colour schemes. The app's functions are all
global, so they can be exercised from page context.
