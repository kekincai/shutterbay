// Caption translation with Workers AI.
//
// One model call translates a caption into every supported language at once and
// reports the language it was written in. Results are stored per caption, so each
// distinct caption costs one call, ever — no matter how many people read it.

import { LANGS, LANG_CODES } from '../public/lang.js';
import { claimCaption, saveCaption, failCaption, spendAiCall } from './db.js';

export const DEFAULT_MODEL = '@cf/google/gemma-4-26b-a4b-it';

/** Stable key for a caption: sha-256 of the trimmed text. */
export async function captionKey(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim()));
  return [...new Uint8Array(buf)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Captions made only of emoji, numbers, punctuation or a lone hashtag are shown as-is. */
export function isTranslatable(text) {
  const words = text.replace(/https?:\/\/\S+|[#@][\p{L}\p{N}_]+|:[A-Za-z0-9_]+:/gu, ' ');
  return (words.match(/\p{L}/gu) || []).length >= 2;
}

const SYSTEM = `You translate short captions that players wrote under video game screenshots.
Detect the caption's language, then translate it into every requested target language.
Rules:
- Keep the tone, slang and emoji. Do not add explanations, quotes or notes.
- Keep game names, place names in the game, @mentions, #hashtags and URLs unchanged.
- For the caption's own language, return the caption unchanged.
- Reply with one JSON object only: {"src":"<one of the target codes, or another ISO 639-1 code>","t":{"<code>":"<translation>", ...}}`;

function extractJson(out) {
  if (out && typeof out === 'object') return out;
  const s = String(out ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in model output');
  return JSON.parse(s.slice(a, b + 1));
}

async function callModel(env, text) {
  const targets = LANGS.map(([code, name]) => `${code} (${name})`).join(', ');
  const res = await env.AI.run(env.TRANSLATE_MODEL || DEFAULT_MODEL, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Target languages: ${targets}\nCaption:\n${text}` },
    ],
    max_tokens: 1500,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false },
  });
  const raw = res?.response ?? res?.choices?.[0]?.message?.content ?? res;
  const data = extractJson(raw);
  const t = {};
  for (const code of LANG_CODES) {
    const v = data?.t?.[code];
    // Guard against runaway or empty output for any single language.
    if (typeof v === 'string' && v.trim() && v.length <= text.length * 4 + 120) t[code] = v.trim();
  }
  if (Object.keys(t).length < LANG_CODES.length / 2) throw new Error('model returned too few languages');
  const src = typeof data?.src === 'string' ? data.src.trim() : '';
  return { src: LANG_CODES.find(c => c.toLowerCase() === src.toLowerCase()) || src.slice(0, 8) || 'und', t };
}

const COMMENT_SYSTEM = `You translate comments that players left under a video game screenshot.
Translate each comment into the target language. Detect each comment's own language.
Rules:
- Keep the tone, slang and emoji. Do not add explanations or notes.
- Keep game names, @mentions, URLs and Steam emoticon codes like :steamhappy: unchanged.
- If a comment is already in the target language, return it unchanged.
- Comments arrive as a JSON array of {"i": number, "text": string}. Translate each one separately; never merge them.
- Reply with one JSON object only: {"r":[{"i":<same number>,"src":"<ISO 639-1 code>","t":"<translation>"}, ...]} with one entry per input comment.`;

/**
 * Translate a batch of comments into one reader language with a single model call.
 * `items` is a list of { key, text }. Returns rows { key, src, text } for every item it managed.
 */
export async function translateComments(env, lang, items) {
  if (!items.length) return [];
  const limit = Number(env.AI_DAILY_CALLS) || 600;
  if (!(await spendAiCall(env.DB, limit))) return [];
  const name = LANGS.find(([c]) => c === lang)?.[1] || lang;
  const res = await env.AI.run(env.TRANSLATE_MODEL || DEFAULT_MODEL, {
    messages: [
      { role: 'system', content: COMMENT_SYSTEM },
      { role: 'user', content: `Target language: ${lang} (${name})\nComments:\n${JSON.stringify(items.map((it, i) => ({ i, text: it.text })))}` },
    ],
    max_tokens: 3000,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false },
  });
  const data = extractJson(res?.response ?? res?.choices?.[0]?.message?.content ?? res);
  const byIndex = new Map((Array.isArray(data?.r) ? data.r : []).map((r, n) => [Number.isInteger(r?.i) ? r.i : n, r]));
  // Anything the model skipped or mangled is stored as-is, so we never pay for it twice.
  return items.map((it, i) => {
    const r = byIndex.get(i);
    const t = typeof r?.t === 'string' ? r.t.trim() : '';
    if (!t || t.length > it.text.length * 4 + 120) return { key: it.key, src: 'und', text: it.text };
    return { key: it.key, src: String(r.src || '').slice(0, 8) || 'und', text: t };
  });
}

/**
 * Translate captions that have no stored translation yet.
 * `captions` is a list of { key, text }. Stops early when the daily AI budget is spent.
 * Returns how many were translated.
 */
export async function translateMissing(env, captions, max) {
  const limit = Number(env.AI_DAILY_CALLS) || 600;
  let done = 0;
  for (const { key, text } of captions.slice(0, max)) {
    if (!(await claimCaption(env.DB, key))) continue;      // someone else is on it, or it's finished
    if (!(await spendAiCall(env.DB, limit))) { await failCaption(env.DB, key); break; }
    try {
      const { src, t } = await callModel(env, text);
      await saveCaption(env.DB, key, src, t);
      done++;
    } catch (e) {
      console.warn('translate failed', key, String(e?.message || e));
      await failCaption(env.DB, key);
    }
  }
  return done;
}
