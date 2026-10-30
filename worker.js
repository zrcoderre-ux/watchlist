// Cloudflare Worker for Watchlist.
//
// Serves the static app (index.html, sw.js, icons) and these APIs under /api/:
//
//   GET  /api/tmdb/<path>  The Movie Database (TMDB) v3, read-only, with the
//                          server's read token. Cached at the edge.
//   GET  /api/ratings/<imdb id>
//                          Rotten Tomatoes, IMDb and Metacritic scores from
//                          OMDb, with the server's key. Kept for good in the
//                          ScoreStore Durable Object, so OMDb is asked about a
//                          title only once in a long while.
//   POST /api/jobs         Starts a Claude job; GET /api/jobs/<id> polls it.
//                          The work runs in a Durable Object, so it carries on
//                          when the phone puts the app in the background.
//   GET  /api/usage        What the app has used of Claude, OMDb and TMDB, by
//                          day (UTC), recorded as the calls go out.
//   POST /api/sync         The watchlist itself, kept in a Durable Object so
//                          a phone and a computer see the same list.
//   GET  /api/ping         Checks the passcode.
//
// Every /api/ call must carry the X-App-Key header matching APP_PASSCODE, so
// nobody who finds the URL can spend the Claude key. Secrets (see SETUP.md):
//
//   npx wrangler secret put APP_PASSCODE
//   npx wrangler secret put TMDB_TOKEN          (TMDB "API Read Access Token")
//   npx wrangler secret put ANTHROPIC_API_KEY
//   npx wrangler secret put OMDB_KEY            (optional: critics' scores)

const TMDB_BASE = 'https://api.themoviedb.org/3/';
// The TMDB paths the app reads. Anything else is refused rather than proxied.
const TMDB_ALLOWED = /^(trending|discover|search|movie|tv|watch\/providers|genre)\//;
const TMDB_CACHE_SECONDS = 6 * 3600;       // providers update daily; trending weekly

const OMDB_BASE = 'https://www.omdbapi.com/';
const OMDB_CACHE_SECONDS = 24 * 3600;      // the free key allows 1,000 lookups a day
// Stored scores are asked for again only this often: a recent title's still
// move, an older one's have settled.
const SCORE_RECHECK_RECENT_MS = 14 * 24 * 3600 * 1000;
const SCORE_RECHECK_OLD_MS = 180 * 24 * 3600 * 1000;
const IMDB_ID = /^tt\d{5,10}$/;
// Of OMDb's 1,000 a day, background filling (?bg=1) may use this many; the
// rest is kept for cards being looked at, For you picks and opened titles.
const OMDB_BACKGROUND_SHARE = 700;

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL_DEFAULT = 'claude-opus-5-5';
const CLAUDE_EFFORTS = ['low', 'medium', 'high'];
const CLAUDE_MAX_BODY = 12 * 1024 * 1024;  // a few downscaled photos
// Long lists are read in pieces of about this size, so no one answer runs out
// of room.
const JOB_CHUNK_LINES = 100;
const JOB_CHUNK_CHARS = 12000;
// The free Workers plan allows 50 outside requests per invocation. Title
// lookups run in slices under that, each in its own alarm.
const JOB_FETCH_BUDGET = 40;
const JOB_KEEP_MS = 24 * 3600 * 1000;      // results wait a day for the app to collect them
const JOB_ID = /^[0-9a-f-]{36}$/;

// Anthropic's list prices, $ per million tokens: input, output, cache read.
// Cache writes cost 1.25x input. Used only to estimate spend for the usage
// panel; the Anthropic Console has the real bill. A model not listed is priced
// as the default.
const CLAUDE_PRICES = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5]
};
// Claude's estimated spend stops here each UTC day: no job starts once today's
// total reaches it, and a long job stops between pieces when it does.
const CLAUDE_DAILY_CAP = 5;
const USAGE_FEATURE = /^[a-z-]{1,20}$/;
const USAGE_KEEP_DAYS = 400;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (!env.APP_PASSCODE) return json({ error: 'APP_PASSCODE is not set on the server.' }, 500);
    if (!passcodeOk(request.headers.get('X-App-Key') || '', env.APP_PASSCODE)) {
      return json({ error: 'Wrong passcode.' }, 401);
    }

    try {
      if (url.pathname === '/api/ping') return json({ ok: true, tmdb: !!env.TMDB_TOKEN, claude: !!env.ANTHROPIC_API_KEY, omdb: !!env.OMDB_KEY });
      if (url.pathname.startsWith('/api/tmdb/') && request.method === 'GET') return await tmdb(url, env, ctx);
      if (url.pathname.startsWith('/api/ratings/') && request.method === 'GET') return await ratings(url, env, ctx);
      if (url.pathname === '/api/jobs' && request.method === 'POST') return await startJob(request, env);
      if (url.pathname.startsWith('/api/jobs/') && request.method === 'GET') {
        const id = url.pathname.slice('/api/jobs/'.length);
        if (!JOB_ID.test(id)) return json({ error: 'Not found.' }, 404);
        return await env.CLAUDE_JOBS.get(env.CLAUDE_JOBS.idFromName(id)).fetch('https://job/status');
      }
      if (url.pathname === '/api/usage' && request.method === 'GET') {
        return await usageStub(env).fetch('https://usage/list');
      }
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        const stub = env.WATCH_STORE.get(env.WATCH_STORE.idFromName('watchlist'));
        return await stub.fetch('https://store/sync', { method: 'POST', body: request.body });
      }
      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 502);
    }
  }
};

// Constant-time comparison, so the passcode can't be guessed a byte at a time.
function passcodeOk(given, expected) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] || 0) ^ b[i];
  return diff === 0;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}

// ── TMDB ───────────────────────────────────────────────────
async function tmdb(url, env, ctx) {
  if (!env.TMDB_TOKEN) return json({ error: 'TMDB_TOKEN is not set on the server.' }, 500);
  const path = url.pathname.slice('/api/tmdb/'.length);
  if (!TMDB_ALLOWED.test(path + '/')) return json({ error: 'That TMDB path is not allowed.' }, 400);

  const upstream = new URL(path, TMDB_BASE);
  upstream.search = url.search;
  // The cache key is the upstream URL: it carries no secret, and every device
  // asking the same question shares the answer.
  const cacheKey = new Request(upstream.toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const res = await fetch(upstream, {
    headers: { Authorization: 'Bearer ' + env.TMDB_TOKEN, Accept: 'application/json' }
  });
  ctx.waitUntil(recordUsage(env, { tmdb: 1 }));
  const body = await res.text();
  const out = new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': res.ok ? `public, max-age=${TMDB_CACHE_SECONDS}` : 'no-store'
    }
  });
  if (res.ok) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// ── Ratings ────────────────────────────────────────────────
// A title's Rotten Tomatoes (critics), IMDb and Metacritic scores, looked up on
// OMDb by IMDb id. Only the three numbers go back; null where OMDb has none.
// Without OMDB_KEY the answer is { off: true } and the app stops asking.
async function ratings(url, env, ctx) {
  if (!env.OMDB_KEY) return json({ off: true });
  const id = url.pathname.slice('/api/ratings/'.length);
  if (!IMDB_ID.test(id)) return json({ error: 'Not found.' }, 404);
  const background = url.searchParams.get('bg') === '1';

  // The cache key leaves the key out, as with TMDB.
  const cacheKey = new Request(OMDB_BASE + '?i=' + id);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const store = env.SCORES.get(env.SCORES.idFromName('scores'));
  const { scores: stored, limitedDay } = await (await store.fetch('https://scores/get?id=' + id)).json();
  let scores = stored && scoresFresh(stored) ? stored : null;
  if (!scores) {
    // Once OMDb says the day's limit is reached, nothing more is asked of it
    // that day; background filling also stops at its share.
    const today = utcDay();
    let refuse = limitedDay === today ? 'all' : null;
    if (!refuse && background) {
      const used = await (await usageStub(env).fetch('https://usage/today')).json();
      if ((used.omdb || 0) >= OMDB_BACKGROUND_SHARE) refuse = 'background';
    }
    if (!refuse) {
      try {
        scores = await omdbScores(id, env);
        ctx.waitUntil(recordUsage(env, { omdb: 1 }));
        await store.fetch('https://scores/put', { method: 'POST', body: JSON.stringify({ id, scores }) });
      } catch (e) {
        if (e.limit) {
          await store.fetch('https://scores/limited', { method: 'POST', body: JSON.stringify({ day: today }) });
          ctx.waitUntil(recordUsage(env, { omdbRefused: 1 }));
          refuse = 'all';
        } else {
          ctx.waitUntil(recordUsage(env, { omdb: 1 }));
          if (!stored) return json({ error: e.message }, 502);
        }
      }
    }
    // What was stored, however old, beats nothing.
    if (!scores) scores = stored;
    if (!scores) {
      return json({ error: "OMDb's daily limit is used up.", paused: refuse, retryAfter: secondsToNextUtcDay() }, 429);
    }
  }
  const out = json({ rt: scores.rt, imdb: scores.imdb, mc: scores.mc }, 200, {
    'Cache-Control': `public, max-age=${OMDB_CACHE_SECONDS}`
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

function utcDay() { return new Date().toISOString().slice(0, 10); }
function secondsToNextUtcDay() {
  return Math.ceil((Date.parse(utcDay() + 'T00:00:00Z') + 864e5 - Date.now()) / 1000);
}

function scoresFresh(s) {
  const recent = !s.year || s.year >= new Date().getUTCFullYear() - 1;
  return Date.now() - (s.at || 0) < (recent ? SCORE_RECHECK_RECENT_MS : SCORE_RECHECK_OLD_MS);
}

// One OMDb lookup: { rt, imdb, mc, year, at }, null where OMDb has no score.
async function omdbScores(id, env) {
  const res = await fetch(OMDB_BASE + '?' + new URLSearchParams({ i: id, apikey: env.OMDB_KEY }), {
    headers: { Accept: 'application/json' }
  });
  const data = await res.json().catch(() => ({}));
  // An unknown title is an answer; a bad key or the day's limit is not.
  if (data.Response !== 'True' && !/not found|incorrect imdb/i.test(data.Error || '')) {
    const err = new Error('OMDb: ' + (data.Error || 'returned ' + res.status));
    err.limit = /limit/i.test(data.Error || '');
    throw err;
  }
  const num = (v, max) => {
    const n = parseFloat(String(v || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };
  const rt = ((data.Ratings || []).find(r => r && r.Source === 'Rotten Tomatoes') || {}).Value;
  return {
    rt: num(rt, 100), imdb: num(data.imdbRating, 10), mc: num(data.Metascore, 100),
    year: parseInt(data.Year, 10) || 0, at: Date.now()
  };
}

// ── Claude ─────────────────────────────────────────────────
// One Messages API call. The app supplies the prompt and a JSON schema; the
// model, key and limits are fixed here. Returns the parsed JSON answer.
// `used` collects each call's usage for the caller to record in one go: the
// free plan allows only 50 outside requests per invocation, so a long import
// can't spend one per call on bookkeeping.
async function callClaude(env, { system, content, schema, effort, feature, used }) {
  const body = {
    model: env.CLAUDE_MODEL || CLAUDE_MODEL_DEFAULT,
    max_tokens: 16000,
    system: String(system || ''),
    messages: [{ role: 'user', content }],
    output_config: { effort: CLAUDE_EFFORTS.includes(effort) ? effort : 'medium' },
    // If a safety classifier declines, retry on Anthropic's recommended model
    // for that case instead of failing.
    fallbacks: 'default'
  };
  if (schema) body.output_config.format = { type: 'json_schema', schema };

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  // Billed whatever the answer turns out to be, so counted first.
  if (data.usage && used) used.push(claudeUsage(feature, data.model || body.model, data.usage));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || ('Claude returned ' + res.status));
    err.retry = res.status === 429 || res.status >= 500;
    throw err;
  }
  const final = msg => Object.assign(new Error(msg), { retry: false });
  if (data.stop_reason === 'refusal') throw final('Claude declined that one. Try rewording it.');
  if (data.stop_reason === 'max_tokens') throw final('Claude ran out of room answering. Try fewer photos at once.');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text); } catch (e) { throw final("Claude's answer couldn't be read. Try again."); }
}

// One call's tokens and estimated cost, filed under the feature that made it.
function claudeUsage(feature, model, u) {
  const [inp, out, read] = CLAUDE_PRICES[model] || CLAUDE_PRICES[CLAUDE_MODEL_DEFAULT];
  const tokIn = u.input_tokens || 0, tokOut = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
  return {
    feature: USAGE_FEATURE.test(feature || '') ? feature : 'other',
    calls: 1, tokIn: tokIn + cacheRead + cacheWrite, tokOut,
    cost: (tokIn * inp + tokOut * out + cacheRead * read + cacheWrite * inp * 1.25) / 1e6
  };
}

// Today's estimated Claude spend, in dollars, as the usage store has it.
async function claudeSpentToday(env) {
  const day = await (await usageStub(env).fetch('https://usage/today')).json();
  return Object.values(day.claude || {}).reduce((sum, c) => sum + (Number(c.cost) || 0), 0);
}
function claudeCapError() {
  return Object.assign(new Error(`Today's Claude budget of $${CLAUDE_DAILY_CAP.toFixed(2)} is used up. It resets at midnight UTC.`), { retry: false });
}

// A job: { system, schema, effort, content } for one call, or { …, intro,
// text } to read a long list in pieces. With resolve set to the name of an
// array in the answer (e.g. "titles"), each { title, year, type } in it is
// looked up on TMDB and comes back with a `match`.
async function startJob(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set on the server.' }, 500);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > CLAUDE_MAX_BODY) return json({ error: 'That request is too large.' }, 413);
  const req = await request.json();
  const hasContent = Array.isArray(req.content) && req.content.length;
  if (!hasContent && !(typeof req.text === 'string' && req.text.trim())) return json({ error: 'Nothing to send.' }, 400);
  if (await claudeSpentToday(env) >= CLAUDE_DAILY_CAP) {
    return json({ error: claudeCapError().message, paused: 'claude', retryAfter: secondsToNextUtcDay() }, 429);
  }
  const id = crypto.randomUUID();
  const stub = env.CLAUDE_JOBS.get(env.CLAUDE_JOBS.idFromName(id));
  return await stub.fetch('https://job/start', { method: 'POST', body: JSON.stringify({ ...req, id }) });
}

// Split a long list at line breaks into pieces Claude can answer in full.
function chunkText(text) {
  const chunks = [];
  let cur = [], size = 0;
  for (const line of text.split('\n')) {
    if (cur.length && (cur.length >= JOB_CHUNK_LINES || size + line.length > JOB_CHUNK_CHARS)) {
      chunks.push(cur.join('\n'));
      cur = []; size = 0;
    }
    if (!line.trim() && !cur.length) continue;
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.join('').trim()) chunks.push(cur.join('\n'));
  return chunks;
}

// Find a title on TMDB. `budget.left` counts the outside requests this
// invocation may still make.
async function lookupTitle(env, { title, year, type }, budget) {
  const q = String(title || '').trim();
  if (!q) return null;
  const search = async (path, params) => {
    budget.left--;
    const u = new URL(path, TMDB_BASE);
    u.search = new URLSearchParams({ language: 'en-US', include_adult: 'false', query: q, ...params });
    const res = await fetch(u, { headers: { Authorization: 'Bearer ' + env.TMDB_TOKEN, Accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error('TMDB returned ' + res.status);
      err.retry = res.status === 429 || res.status >= 500;
      throw err;
    }
    return (await res.json()).results || [];
  };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const best = (results, t) => {
    const list = results
      .map(r => ({ r, type: t || r.media_type }))
      .filter(x => x.type === 'movie' || x.type === 'tv')
      .map(x => ({ ...x, title: x.r.title || x.r.name, year: Number(String(x.r.release_date || x.r.first_air_date || '').slice(0, 4)) }));
    const hit = list.find(x => norm(x.title) === norm(q) && (!year || Math.abs(x.year - year) <= 1)) ||
      list.find(x => norm(x.title) === norm(q)) || list[0];
    if (!hit) return null;
    // Only what the app keeps, so a long list's results stay small.
    const r = hit.r;
    return {
      type: hit.type,
      r: {
        id: r.id, title: r.title, name: r.name, release_date: r.release_date, first_air_date: r.first_air_date,
        poster_path: r.poster_path, backdrop_path: r.backdrop_path, genre_ids: r.genre_ids,
        overview: String(r.overview || '').slice(0, 600), vote_average: r.vote_average, vote_count: r.vote_count, original_language: r.original_language
      }
    };
  };
  if (type === 'movie' || type === 'tv') {
    const yk = type === 'movie' ? 'year' : 'first_air_date_year';
    let r = await search('search/' + type, year ? { [yk]: year } : {});
    if (!r.length && year) r = await search('search/' + type, {});
    if (r.length) return best(r, type);
  }
  return best(await search('search/multi', {}));
}

// ── Usage ──────────────────────────────────────────────────
// Counts of what went out to Claude, OMDb and TMDB, one record per UTC day.
// Counting never gets in the way of the call it counts.
function usageStub(env) {
  return env.USAGE.get(env.USAGE.idFromName('usage'));
}
async function recordUsage(env, delta) {
  try {
    await usageStub(env).fetch('https://usage/add', { method: 'POST', body: JSON.stringify(delta) });
  } catch (e) {}
}

export class UsageStore {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const storage = this.ctx.storage;
    if (path === '/add' && request.method === 'POST') {
      const d = await request.json();
      const key = 'day:' + utcDay();
      const day = (await storage.get(key)) || { claude: {}, omdb: 0, tmdb: 0 };
      day.omdb += Number(d.omdb) || 0;
      day.omdbRefused = (day.omdbRefused || 0) + (Number(d.omdbRefused) || 0);
      day.tmdb += Number(d.tmdb) || 0;
      for (const c of Array.isArray(d.claude) ? d.claude : []) {
        const name = USAGE_FEATURE.test(c.feature || '') ? c.feature : 'other';
        const f = day.claude[name] || (day.claude[name] = { calls: 0, tokIn: 0, tokOut: 0, cost: 0 });
        for (const k of ['calls', 'tokIn', 'tokOut', 'cost']) f[k] += Number(c[k]) || 0;
      }
      await storage.put(key, day);
      return json({ ok: true });
    }
    if (path === '/today') return json((await storage.get('day:' + utcDay())) || { omdb: 0 });
    if (path === '/list') {
      const since = 'day:' + new Date(Date.now() - USAGE_KEEP_DAYS * 864e5).toISOString().slice(0, 10);
      const days = {};
      for (const [k, v] of await storage.list({ prefix: 'day:' })) {
        if (k < since) await storage.delete(k);
        else days[k.slice(4)] = v;
      }
      return json({ today: new Date().toISOString().slice(0, 10), days, claudeDailyCap: CLAUDE_DAILY_CAP });
    }
    return json({ error: 'Not found.' }, 404);
  }
}

// ── Score store ────────────────────────────────────────────
// Every title's scores as OMDb last gave them, one storage key per IMDb id.
export class ScoreStore {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/get') {
      const id = url.searchParams.get('id') || '';
      return json({
        scores: IMDB_ID.test(id) ? (await this.ctx.storage.get('score:' + id)) || null : null,
        limitedDay: (await this.ctx.storage.get('limitedDay')) || ''
      });
    }
    if (url.pathname === '/limited' && request.method === 'POST') {
      await this.ctx.storage.put('limitedDay', (await request.json()).day);
      return json({ ok: true });
    }
    if (url.pathname === '/put' && request.method === 'POST') {
      const { id, scores } = await request.json();
      if (IMDB_ID.test(id) && scores) await this.ctx.storage.put('score:' + id, scores);
      return json({ ok: true });
    }
    return json({ error: 'Not found.' }, 404);
  }
}

// ── Sync store ─────────────────────────────────────────────
// One Durable Object holds the whole list: one storage key per title, plus the
// preferences. A device posts what it changed since it last synced and gets
// back everything that changed on the server since then. Conflicts go to
// whichever edit is newer (each record carries the time it was edited).
export class WatchStore {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const { since = 0, items = [], prefs = null } = await request.json();
    const now = Date.now();
    const storage = this.ctx.storage;

    const incoming = items.filter(it => it && typeof it.key === 'string' && it.key.length < 64);
    for (let i = 0; i < incoming.length; i += 100) {
      const batch = incoming.slice(i, i + 100);
      const existing = await storage.get(batch.map(it => 'item:' + it.key));
      const writes = {};
      for (const it of batch) {
        const cur = existing.get('item:' + it.key);
        if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) {
          writes['item:' + it.key] = { ...it, serverAt: now };
        }
      }
      if (Object.keys(writes).length) await storage.put(writes);
    }

    let storedPrefs = await storage.get('prefs');
    if (prefs && (!storedPrefs || (prefs.updatedAt || 0) > (storedPrefs.updatedAt || 0))) {
      storedPrefs = { ...prefs, serverAt: now };
      await storage.put('prefs', storedPrefs);
    }

    const changed = [];
    const all = await storage.list({ prefix: 'item:' });
    for (const it of all.values()) if ((it.serverAt || 0) > since) changed.push(it);

    return json({
      now,
      items: changed,
      prefs: storedPrefs && (storedPrefs.serverAt || 0) > since ? storedPrefs : null
    });
  }
}

// ── Claude jobs ────────────────────────────────────────────
// One Durable Object per job. Starting one stores the request and sets an
// alarm; the alarm does the work, so it runs to the end even after the phone
// that asked has suspended the app. The app polls for the result.
export class ClaudeJob {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const storage = this.ctx.storage;
    const path = new URL(request.url).pathname;
    if (path === '/start') {
      const req = await request.json();
      const pieces = typeof req.text === 'string' && req.text.trim()
        ? chunkText(req.text).map(t => [{ type: 'text', text: (req.intro ? req.intro + '\n\n' : '') + t }])
        : [req.content];
      // Each content block in its own key: a few photos can run to megabytes,
      // more than one stored value may hold.
      const keys = [];
      for (let i = 0; i < pieces.length; i++) {
        keys.push(pieces[i].map((_, b) => `piece:${i}:${b}`));
        for (let b = 0; b < pieces[i].length; b++) await storage.put(keys[i][b], pieces[i][b]);
      }
      await storage.put('job', {
        id: req.id,
        status: 'reading',
        system: req.system, schema: req.schema, effort: req.effort, feature: req.feature,
        resolve: typeof req.resolve === 'string' ? req.resolve : '',
        keys,
        attempts: 0,
        createdAt: Date.now()
      });
      await storage.setAlarm(Date.now());
      return json({ id: req.id });
    }
    const job = await storage.get('job');
    if (!job) return json({ error: 'That job has expired. Try again.' }, 404);
    const out = { status: job.status };
    if (job.status === 'looking-up') { out.done = job.cursor; out.total = job.items.length; }
    if (job.status === 'done') out.result = job.result;
    if (job.status === 'error') out.error = job.error;
    return json(out);
  }

  async alarm() {
    const storage = this.ctx.storage;
    const job = await storage.get('job');
    if (!job) return;
    if (job.status === 'done' || job.status === 'error') {
      if (Date.now() - job.createdAt >= JOB_KEEP_MS) await storage.deleteAll();
      return;
    }
    try {
      if (job.status === 'reading') await this.read(job);
      else if (job.status === 'looking-up') await this.lookUp(job);
    } catch (e) {
      job.attempts++;
      if (e.retry !== false && job.attempts < 3) {
        await storage.put('job', job);
        await storage.setAlarm(Date.now() + 3000 * job.attempts);
        return;
      }
      job.status = 'error';
      job.error = e.message || String(e);
    }
    await storage.put('job', job);
    if (job.status === 'done' || job.status === 'error') {
      const keys = job.keys.flat();
      for (let i = 0; i < keys.length; i += 100) await storage.delete(keys.slice(i, i + 100));
      await storage.setAlarm(job.createdAt + JOB_KEEP_MS);
    } else {
      await storage.setAlarm(Date.now());
    }
  }

  // Ask Claude, a piece at a time for a long list (a few at once), stopping
  // between batches once today's spend reaches CLAUDE_DAILY_CAP.
  async read(job) {
    const answers = [], used = [];
    const spent = await claudeSpentToday(this.env);
    try {
      for (let i = 0; i < job.keys.length; i += 4) {
        if (spent + used.reduce((sum, u) => sum + u.cost, 0) >= CLAUDE_DAILY_CAP) throw claudeCapError();
        const batch = [];
        for (let j = i; j < Math.min(job.keys.length, i + 4); j++) {
          const got = await this.ctx.storage.get(job.keys[j]);
          const content = job.keys[j].map(k => got.get(k));
          batch.push(callClaude(this.env, { system: job.system, content, schema: job.schema, effort: job.effort, feature: job.feature, used }));
        }
        // Let every call in the batch finish, so all of them are counted.
        const settled = await Promise.allSettled(batch);
        const failed = settled.find(r => r.status === 'rejected');
        if (failed) throw failed.reason;
        answers.push(...settled.map(r => r.value));
      }
    } finally {
      if (used.length) await recordUsage(this.env, { claude: used });
    }
    if (!job.resolve) {
      job.result = answers[0];
      job.status = 'done';
      return;
    }
    // Keep the first answer's other fields; join the lists.
    job.result = { ...answers[0], [job.resolve]: [] };
    job.items = answers.flatMap(a => Array.isArray(a[job.resolve]) ? a[job.resolve] : []);
    job.cursor = 0;
    job.attempts = 0;
    job.status = job.items.length ? 'looking-up' : 'done';
    if (!job.items.length) job.result[job.resolve] = [];
  }

  // Look titles up on TMDB, as many as this invocation's request budget allows.
  async lookUp(job) {
    const budget = { left: JOB_FETCH_BUDGET };
    while (job.cursor < job.items.length && budget.left >= 12) {
      const batch = job.items.slice(job.cursor, job.cursor + 4);
      const matches = await Promise.all(batch.map(it => lookupTitle(this.env, it, budget)));
      batch.forEach((it, k) => { it.match = matches[k]; });
      job.cursor += batch.length;
    }
    if (budget.left < JOB_FETCH_BUDGET) await recordUsage(this.env, { tmdb: JOB_FETCH_BUDGET - budget.left });
    job.attempts = 0;
    if (job.cursor >= job.items.length) {
      job.result[job.resolve] = job.items;
      delete job.items;
      job.status = 'done';
    }
  }
}
