// Cloudflare Worker for Watchlist.
//
// Serves the static app (index.html, sw.js, icons) and three APIs under /api/:
//
//   GET  /api/tmdb/<path>  The Movie Database (TMDB) v3, read-only, with the
//                          server's read token. Cached at the edge.
//   POST /api/claude       The Anthropic Messages API with the server's key.
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

const TMDB_BASE = 'https://api.themoviedb.org/3/';
// The TMDB paths the app reads. Anything else is refused rather than proxied.
const TMDB_ALLOWED = /^(trending|discover|search|movie|tv|watch\/providers|genre)\//;
const TMDB_CACHE_SECONDS = 6 * 3600;       // providers update daily; trending weekly

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL_DEFAULT = 'claude-opus-5-5';
const CLAUDE_EFFORTS = ['low', 'medium', 'high'];
const CLAUDE_MAX_BODY = 12 * 1024 * 1024;  // a few downscaled photos

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (!env.APP_PASSCODE) return json({ error: 'APP_PASSCODE is not set on the server.' }, 500);
    if (!passcodeOk(request.headers.get('X-App-Key') || '', env.APP_PASSCODE)) {
      return json({ error: 'Wrong passcode.' }, 401);
    }

    try {
      if (url.pathname === '/api/ping') return json({ ok: true, tmdb: !!env.TMDB_TOKEN, claude: !!env.ANTHROPIC_API_KEY });
      if (url.pathname.startsWith('/api/tmdb/') && request.method === 'GET') return await tmdb(url, env, ctx);
      if (url.pathname === '/api/claude' && request.method === 'POST') return await claude(request, env);
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

// ── Claude ─────────────────────────────────────────────────
// The app sends the prompt and a JSON schema; the model, key and limits are
// fixed here. Replies come back as { text, stop_reason, model }.
async function claude(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set on the server.' }, 500);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > CLAUDE_MAX_BODY) return json({ error: 'That request is too large.' }, 413);

  const req = await request.json();
  if (!Array.isArray(req.content) || !req.content.length) return json({ error: 'Nothing to send.' }, 400);

  const body = {
    model: env.CLAUDE_MODEL || CLAUDE_MODEL_DEFAULT,
    max_tokens: 16000,
    system: String(req.system || ''),
    messages: [{ role: 'user', content: req.content }],
    output_config: { effort: CLAUDE_EFFORTS.includes(req.effort) ? req.effort : 'medium' },
    // If a safety classifier declines, retry on Anthropic's recommended model
    // for that case instead of failing.
    fallbacks: 'default'
  };
  if (req.schema) body.output_config.format = { type: 'json_schema', schema: req.schema };

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
  if (!res.ok) {
    const msg = (data.error && data.error.message) || ('Claude returned ' + res.status);
    return json({ error: msg }, res.status === 429 || res.status >= 500 ? 503 : 502);
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return json({ text, stop_reason: data.stop_reason, model: data.model });
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
