// Language negotiation shared by the page (browser) and the Worker (server).
// Order of preference: explicit ?lang= → browser languages → IP country → English.

/** Supported languages: [code, native name]. The first entry is the fallback. */
export const LANGS = [
  ['en', 'English'],
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['pt-BR', 'Português (Brasil)'],
  ['ru', 'Русский'],
];
export const LANG_CODES = LANGS.map(([c]) => c);
export const DEFAULT_LANG = 'en';

/** Map one BCP-47 tag (e.g. "zh-Hant-HK", "pt-PT", "en-US") to a supported code, or null. */
export function matchLang(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const t = tag.trim().toLowerCase().replace(/_/g, '-');
  if (!t || t === '*') return null;
  if (t.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(t) ? 'zh-TW' : 'zh-CN';
  if (t === 'pt' || t.startsWith('pt-')) return 'pt-BR';
  const exact = LANG_CODES.find(c => c.toLowerCase() === t);
  if (exact) return exact;
  const base = t.split('-')[0];
  return LANG_CODES.find(c => c.split('-')[0].toLowerCase() === base) || null;
}

/** First supported language in a preference list, or null. */
export function negotiate(tags) {
  for (const tag of tags || []) {
    const hit = matchLang(tag);
    if (hit) return hit;
  }
  return null;
}

/** Parse an Accept-Language header into tags ordered by q-value. */
export function parseAcceptLanguage(header) {
  if (!header) return [];
  return header.split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
      return { tag, q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter(x => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map(x => x.tag);
}

// ISO 3166 country → language, used only when the browser asks for nothing we support.
const COUNTRY = {
  'zh-CN': 'CN SG',
  'zh-TW': 'TW HK MO',
  ja: 'JP',
  ko: 'KR',
  es: 'ES MX AR CO CL PE VE EC GT CU BO DO HN PY SV NI CR PA UY PR',
  fr: 'FR BE MC LU SN CI',
  de: 'DE AT CH LI',
  'pt-BR': 'BR PT AO MZ',
  ru: 'RU BY KZ KG',
};
export function langFromCountry(country) {
  if (!country) return null;
  const cc = String(country).toUpperCase();
  for (const [code, list] of Object.entries(COUNTRY)) if (list.split(' ').includes(cc)) return code;
  return null;
}
