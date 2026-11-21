// D1 storage. The schema creates itself on first use, so a fresh fork only
// needs `wrangler deploy` — no separate migration step.

const SCHEMA = [
  // Latest snapshot of each Steam listing page, so visitors never wait on Steam.
  `CREATE TABLE IF NOT EXISTS feed_cache (
     key TEXT PRIMARY KEY,          -- appid:sort:page
     body TEXT NOT NULL,            -- JSON { items, more }
     fetched_at INTEGER NOT NULL)`,
  // One row per distinct caption, holding every language at once.
  `CREATE TABLE IF NOT EXISTS captions (
     key TEXT PRIMARY KEY,          -- sha-256 of the caption text
     status INTEGER NOT NULL,       -- 0 = translating, 1 = done, 2 = failed
     src TEXT,                      -- detected source language
     t TEXT,                        -- JSON { "<lang>": "<text>" }
     updated_at INTEGER NOT NULL)`,
  // Latest snapshot of a screenshot's comment page.
  `CREATE TABLE IF NOT EXISTS comments_cache (
     key TEXT PRIMARY KEY,          -- publishedfileid:start
     body TEXT NOT NULL,
     fetched_at INTEGER NOT NULL)`,
  // Comment translations, one row per (comment text, reader language).
  `CREATE TABLE IF NOT EXISTS comment_tr (
     key TEXT NOT NULL,             -- sha-256 of the comment text
     lang TEXT NOT NULL,
     src TEXT,
     text TEXT NOT NULL,
     PRIMARY KEY (key, lang))`,
  // Short-lived locks so concurrent readers don't pay for the same translation twice.
  `CREATE TABLE IF NOT EXISTS jobs (
     key TEXT PRIMARY KEY,
     status INTEGER NOT NULL,       -- 0 = running, 1 = done, 2 = failed
     updated_at INTEGER NOT NULL)`,
  // Daily Workers AI call counter, to stay inside the free allocation.
  `CREATE TABLE IF NOT EXISTS ai_usage (
     day TEXT PRIMARY KEY,
     calls INTEGER NOT NULL)`,
];

let ready = null;
export function init(db) {
  ready ??= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; });
  return ready;
}

export async function readFeed(db, key) {
  return db.prepare('SELECT body, fetched_at FROM feed_cache WHERE key = ?').bind(key).first();
}
export async function writeFeed(db, key, data) {
  await db.prepare(
    `INSERT INTO feed_cache (key, body, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
  ).bind(key, JSON.stringify(data), Date.now()).run();
}
export async function pruneFeeds(db, olderThanMs) {
  const before = Date.now() - olderThanMs;
  await db.batch([
    db.prepare('DELETE FROM feed_cache WHERE fetched_at < ?').bind(before),
    db.prepare('DELETE FROM comments_cache WHERE fetched_at < ?').bind(before),
    db.prepare('DELETE FROM jobs WHERE updated_at < ?').bind(before),
  ]);
}

export async function readComments(db, key) {
  return db.prepare('SELECT body, fetched_at FROM comments_cache WHERE key = ?').bind(key).first();
}
export async function writeComments(db, key, data) {
  await db.prepare(
    `INSERT INTO comments_cache (key, body, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
  ).bind(key, JSON.stringify(data), Date.now()).run();
}
export async function readCommentTr(db, lang, keys) {
  if (!keys.length) return new Map();
  const { results } = await db.prepare(
    `SELECT key, src, text FROM comment_tr WHERE lang = ? AND key IN (${keys.map(() => '?').join(',')})`,
  ).bind(lang, ...keys).all();
  return new Map(results.map(r => [r.key, r]));
}
export async function saveCommentTr(db, lang, rows) {
  if (!rows.length) return;
  await db.batch(rows.map(r => db.prepare(
    `INSERT INTO comment_tr (key, lang, src, text) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, lang) DO UPDATE SET src = excluded.src, text = excluded.text`,
  ).bind(r.key, lang, r.src, r.text)));
}

/** Take a job lock. Returns false if another request holds it (or it finished recently). */
export async function claimJob(db, key, now = Date.now()) {
  const r = await db.prepare(
    `INSERT INTO jobs (key, status, updated_at) VALUES (?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET status = 0, updated_at = excluded.updated_at
     WHERE jobs.updated_at < ?`,
  ).bind(key, now, now - 2 * 60e3).run();
  return r.meta.changes > 0;
}
export async function finishJob(db, key, ok) {
  await db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE key = ?').bind(ok ? 1 : 2, Date.now(), key).run();
}

export async function readCaptions(db, keys) {
  if (!keys.length) return new Map();
  const { results } = await db.prepare(
    `SELECT key, status, src, t FROM captions WHERE key IN (${keys.map(() => '?').join(',')})`,
  ).bind(...keys).all();
  return new Map(results.map(r => [r.key, r]));
}

/** Claim a caption for translation. Only one worker wins; failed or stuck claims can be retried later. */
export async function claimCaption(db, key, now = Date.now()) {
  const r = await db.prepare(
    `INSERT INTO captions (key, status, updated_at) VALUES (?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET status = 0, updated_at = excluded.updated_at
     WHERE (captions.status = 2 AND captions.updated_at < ?) OR (captions.status = 0 AND captions.updated_at < ?)`,
  ).bind(key, now, now - 6 * 3600e3, now - 10 * 60e3).run();
  return r.meta.changes > 0;
}
export async function saveCaption(db, key, src, t) {
  await db.prepare('UPDATE captions SET status = 1, src = ?, t = ?, updated_at = ? WHERE key = ?')
    .bind(src, JSON.stringify(t), Date.now(), key).run();
}
export async function failCaption(db, key) {
  await db.prepare('UPDATE captions SET status = 2, updated_at = ? WHERE key = ?').bind(Date.now(), key).run();
}

/** Count one AI call against today's budget. Returns false once the budget is spent. */
export async function spendAiCall(db, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const r = await db.prepare(
    `INSERT INTO ai_usage (day, calls) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET calls = calls + 1 WHERE calls < ?`,
  ).bind(day, limit).run();
  return r.meta.changes > 0;
}
