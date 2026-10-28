# Setting up Watchlist

Watchlist runs as one Cloudflare Worker, the same way Inbox Cleaner does. The
Worker serves the app and holds its secrets so they never reach a browser:

| Secret | What it is |
| --- | --- |
| `TMDB_TOKEN` | Your TMDB **API Read Access Token** (the long one, not the short "API Key"). |
| `ANTHROPIC_API_KEY` | Your Claude API key. |
| `OMDB_KEY` | Optional. Your OMDb API key, for Rotten Tomatoes, IMDb and Metacritic scores on each title. |
| `APP_PASSCODE` | Any passphrase you choose. Each device asks for it once; the Worker refuses every `/api/` call without it, so nobody who finds the URL can spend your Claude key. |

## 1. Get a TMDB token (free)

1. Make an account at <https://www.themoviedb.org/signup>.
2. Go to **Settings → API** (<https://www.themoviedb.org/settings/api>) and
   request an API key for personal use.
3. Copy the **API Read Access Token**.

TMDB supplies the catalog: trending and popular titles, posters, genres, and
where each title is streaming (JustWatch data, refreshed daily).

## 2. Deploy the Worker

Either connect the repo in the Cloudflare dashboard (**Workers & Pages →
Create → Import a repository**, pick `watchlist`, no build command), so every
merge to `main` deploys, or deploy from a terminal:

```sh
npx wrangler deploy
```

The deploy creates the `WatchStore` Durable Object that keeps your list in
sync across devices; there's nothing to set up for it.

## 3. Add the secrets

```sh
npx wrangler secret put TMDB_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APP_PASSCODE
npx wrangler secret put OMDB_KEY        # optional
```

(Or in the dashboard: the Worker → **Settings → Variables and Secrets**, type
**Secret**.)

## 4. Open it

Open the Worker's URL on your phone, enter the passcode, pick your streaming
services, and add it to your home screen (Share → Add to Home Screen on
iPhone; the install prompt on Android or desktop Chrome).

## Critics' scores (optional)

TMDB doesn't carry Rotten Tomatoes scores, and Rotten Tomatoes has no public
API, so they come from OMDb. Get a free key at
<https://www.omdbapi.com/apikey.aspx> (it arrives by email and must be
activated from the link in it), then set it as `OMDB_KEY`.

A title's sheet then shows its Rotten Tomatoes (critics), IMDb and Metacritic
scores where OMDb has them; OMDb has no audience score, and TV coverage is
thinner than for films. The Worker keeps every title's scores (in the
`ScoreStore` Durable Object, which the deploy creates) and asks OMDb again
only every couple of weeks for new releases and twice a year for older ones,
so the free key's 1,000 lookups a day go a long way. Without the key the
scores just don't appear.

## Claude model and cost

Claude is called for three things: reading photos and lists (low effort),
"For you" suggestions, and Tonight's picks (medium effort). Each call goes to
`claude-opus-5-5` unless you set a different model:

```toml
# wrangler.toml
[vars]
CLAUDE_MODEL = "claude-sonnet-5-5"
```

Nothing calls Claude in the background; it only runs when you tap
**For you**, **Pick for me**, or import something.

## Your Google watchlist

Google doesn't offer an API for the Google TV / Google Search watchlist, so
the app can't read it directly. To bring it over, screenshot the list (Google
TV app → Library → Watchlist, or search "my watchlist" in Google) and use
**Settings → Import screenshots**. Claude reads the titles; you tick which to
add. **Import a file** takes any text or CSV list the same way.

## Running it locally

Put the secrets in a `.dev.vars` file (already git-ignored):

```
TMDB_TOKEN=...
ANTHROPIC_API_KEY=...
APP_PASSCODE=...
OMDB_KEY=...
```

then `npx wrangler dev` and open the URL it prints.
