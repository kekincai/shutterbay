// Shutterbay Worker
//
//   GET /api/feed?sort=trendweek&page=1[&appid=3240220][&lang=ja]
//       → { appid, game, sort, page, lang, more, pending, items: [...] }
//   GET /api/comments?id=<publishedfileid>&owner=<author key>&start=0
//   GET /api/health
//   everything else → static files in /public
//
// Cron (wrangler.jsonc → triggers.crons) refreshes the first pages of each feed and
// translates new captions ahead of time, so readers rarely wait for either.

import { matchLang, negotiate, parseAcceptLanguage, langFromCountry, DEFAULT_LANG } from '../public/lang.js';
import { fetchScreenshots, fetchComments, SORTS, PER_PAGE, COMMENTS_PER_PAGE } from './steam.js';
import {
  init, readFeed, writeFeed, pruneFeeds, readCaptions,
  readComments, writeComments, readCommentTr, saveCommentTr, claimJob, finishJob,
} from './db.js';
import { captionKey, isTranslatable, translateMissing, translateComments } from './translate.js';

const FRESH_MS = 15 * 60e3;          // serve a cached listing page for up to 15 minutes
const MAX_PAGE = 20;
const INLINE_TRANSLATIONS = 6;       // captions translated in the background per request
const GAMES = { 3240220: 'GTA V', 271590: 'GTA V' };

const appids = env => (env.STEAM_APPIDS || '3240220').split(',').map(s => s.trim()).filter(s => /^\d{1,10}$/.test(s));

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers },
});

/** Browser preference first (explicit ?lang, then Accept-Language), then the visitor's country, then English. */
export function resolveLang(req, url) {
  return matchLang(url.searchParams.get('lang'))
    || negotiate(parseAcceptLanguage(req.headers.get('Accept-Language')))
    || langFromCountry(req.cf?.country)
    || DEFAULT_LANG;
}

async function getListing(env, ctx, appid, sort, page) {
  const key = `${appid}:${sort}:${page}`;
  const row = await readFeed(env.DB, key);
  if (row && Date.now() - row.fetched_at < FRESH_MS) return JSON.parse(row.body);
  try {
    const items = await fetchScreenshots(appid, sort, page);
    const data = { items, more: items.length >= PER_PAGE };
    ctx.waitUntil(writeFeed(env.DB, key, data).catch(e => console.warn('cache write', e)));
    return data;
  } catch (e) {
    if (row) return JSON.parse(row.body);   // Steam is down: an older page beats an error
    throw e;
  }
}

async function feed(req, env, ctx, url) {
  const allowed = appids(env);
  const appid = allowed.includes(url.searchParams.get('appid')) ? url.searchParams.get('appid') : allowed[0];
  const sort = SORTS.includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'trendweek';
  const page = Math.min(MAX_PAGE, Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1));
  const lang = resolveLang(req, url);

  const data = await getListing(env, ctx, appid, sort, page);

  // Attach stored translations; queue the captions we have never seen.
  const keys = await Promise.all(data.items.map(it => (it.title && isTranslatable(it.title) ? captionKey(it.title) : null)));
  const stored = await readCaptions(env.DB, [...new Set(keys.filter(Boolean))]);
  const missing = [];
  let pending = 0;
  const items = data.items.map((it, i) => {
    const { title, ...rest } = it;
    const out = { ...rest, cap: title };
    const key = keys[i];
    if (!key) return out;
    const row = stored.get(key);
    if (row?.status === 1) {
      const text = JSON.parse(row.t || '{}')[lang];
      if (row.src !== lang && text && text !== title) Object.assign(out, { cap: text, orig: title, tl: true });
    } else if (!row || row.status === 0) {
      pending++;
      missing.push({ key, text: title });
    }
    return out;
  });
  if (missing.length && env.AI) {
    ctx.waitUntil(translateMissing(env, missing, INLINE_TRANSLATIONS).catch(e => console.warn('translate', e)));
  }

  return json(
    { appid: +appid, game: GAMES[appid] || 'Steam', sort, page, lang, more: data.more && page < MAX_PAGE, pending, items },
    200,
    { 'Cache-Control': pending ? 'no-store' : 'public, max-age=60', Vary: 'Accept-Language' },
  );
}

//   GET /api/comments?id=<publishedfileid>&owner=<author key>&start=0[&lang=ja]
//       → { id, total, start, lang, pending, comments: [{ id, text, orig?, tl?, at, author }] }  (oldest first)
async function comments(req, env, ctx, url) {
  const id = url.searchParams.get('id') || '';
  if (!/^\d{1,20}$/.test(id)) return json({ error: 'bad id' }, 400);
  const owner = url.searchParams.get('owner') || '';
  if (owner && !/^(profiles\/\d{17}|id\/[\w.-]{1,64})$/.test(owner)) return json({ error: 'bad owner' }, 400);
  const start = Math.min(5000, Math.max(0, parseInt(url.searchParams.get('start'), 10) || 0));
  const lang = resolveLang(req, url);

  const cacheKey = `${id}:${start}`;
  const row = await readComments(env.DB, cacheKey);
  let data;
  if (row && Date.now() - row.fetched_at < FRESH_MS / 3) data = JSON.parse(row.body);
  else {
    try {
      data = await fetchComments(id, owner, start, COMMENTS_PER_PAGE);
      ctx.waitUntil(writeComments(env.DB, cacheKey, data).catch(e => console.warn('comments cache', e)));
    } catch (e) {
      if (!row) throw e;
      data = JSON.parse(row.body);
    }
  }

  const keys = await Promise.all(data.comments.map(c => (isTranslatable(c.text) ? captionKey(c.text) : null)));
  const stored = await readCommentTr(env.DB, lang, [...new Set(keys.filter(Boolean))]);
  const missing = new Map();
  const list = data.comments.map((c, i) => {
    const out = { ...c };
    const key = keys[i];
    if (!key) return out;
    const tr = stored.get(key);
    if (tr) { if (tr.src !== lang && tr.src !== 'und' && tr.text !== c.text) Object.assign(out, { text: tr.text, orig: c.text, tl: true }); }
    else missing.set(key, c.text);
    return out;
  }).reverse();                                   // Steam sends newest first; read top to bottom

  if (missing.size && env.AI) {
    const job = `cm:${cacheKey}:${lang}`;
    ctx.waitUntil((async () => {
      if (!(await claimJob(env.DB, job))) return;
      let ok = false;
      try {
        const rows = await translateComments(env, lang, [...missing].map(([key, text]) => ({ key, text })));
        await saveCommentTr(env.DB, lang, rows);
        ok = rows.length > 0;
      } catch (e) {
        console.warn('comment translate', String(e?.message || e));
      }
      await finishJob(env.DB, job, ok);
    })());
  }

  return json(
    { id, total: data.total, start, size: COMMENTS_PER_PAGE, lang, pending: missing.size, comments: list },
    200,
    { 'Cache-Control': missing.size ? 'no-store' : 'public, max-age=60', Vary: 'Accept-Language' },
  );
}

async function refresh(env) {
  await init(env.DB);
  const todo = new Map();
  for (const appid of appids(env)) {
    for (const sort of ['trendweek', 'mostrecent']) {
      for (const page of [1, 2]) {
        try {
          const items = await fetchScreenshots(appid, sort, page);
          await writeFeed(env.DB, `${appid}:${sort}:${page}`, { items, more: items.length >= PER_PAGE });
          for (const it of items) {
            if (it.title && isTranslatable(it.title)) todo.set(await captionKey(it.title), it.title);
          }
        } catch (e) {
          console.warn('refresh', appid, sort, page, String(e?.message || e));
        }
      }
    }
  }
  const stored = await readCaptions(env.DB, [...todo.keys()]);
  const missing = [...todo].filter(([k]) => !stored.has(k) || stored.get(k).status !== 1).map(([key, text]) => ({ key, text }));
  if (missing.length && env.AI) await translateMissing(env, missing, Number(env.CRON_TRANSLATIONS) || 20);
  await pruneFeeds(env.DB, 7 * 24 * 3600e3);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const route = { '/api/feed': feed, '/api/comments': comments }[url.pathname];
    if (route) {
      if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, { Allow: 'GET' });
      try {
        await init(env.DB);
        return await route(req, env, ctx, url);
      } catch (e) {
        console.error(url.pathname, e);
        return json({ error: 'Unavailable right now.' }, 502, { 'Cache-Control': 'no-store' });
      }
    }
    if (url.pathname === '/api/health') return json({ ok: true });
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
};
