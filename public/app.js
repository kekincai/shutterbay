import { negotiate, DEFAULT_LANG } from './lang.js';
import { STRINGS } from './i18n.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const APPID = /^\d{1,10}$/.test(params.get('appid') || '') ? params.get('appid') : '';
const GAME_NAMES = { 3240220: 'GTA V', 271590: 'GTA V' };

/* ---------- language ----------
 * The browser's language list decides first. If it names nothing we support, the
 * server falls back to the visitor's country (Cloudflare knows it from the IP)
 * and tells us which language it picked in every feed response. */
const browserLang = negotiate([params.get('lang'), ...(navigator.languages || [navigator.language])].filter(Boolean));
let lang = browserLang || DEFAULT_LANG;
const t = (k, vars = {}) => ((STRINGS[lang] || {})[k] ?? STRINGS.en[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => vars[x] ?? '');
function applyLang(next) {
  if (next && next !== lang && STRINGS[next]) { lang = next; if (typeof renderFeed === 'function' && $('#feed').childElementCount) queueMicrotask(() => renderFeed(true)); }
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('[data-ta]').forEach(el => el.setAttribute('aria-label', t(el.dataset.ta)));
}

/* ---------- icons ---------- */
const ICON = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  homeF: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  eye: '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  eyeF: '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  heartF: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  bubble: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" transform="rotate(-8 12 12)"/>',
  user: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="10" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 18.2c1.2-2.4 3.2-3.4 5.5-3.4s4.3 1 5.5 3.4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
};
const svgI = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
document.querySelectorAll('svg[data-i]').forEach(s => { s.innerHTML = ICON[s.dataset.i]; s.setAttribute('aria-hidden', 'true'); });

/* ---------- helpers ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = n => new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: likes just won't persist */ } },
};
// Steam's image CDN resizes on request; ask for the width we actually draw.
const sized = (base, w) => `${base}?imw=${w}&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=false`;
function imgTag(p, cls = '') {
  const alt = p.cap || t('shot_by', { name: USERS.get(p.u)?.name || '' });
  return `<img class="${cls}" src="${esc(sized(p.img, 1024))}" srcset="${esc(sized(p.img, 640))} 640w, ${esc(sized(p.img, 1024))} 1024w, ${esc(sized(p.img, 1600))} 1600w"
    sizes="(min-width:480px) 480px, 100vw" alt="${esc(alt)}" loading="lazy" decoding="async">`;
}
// Keep each screenshot's real shape, within portrait 4:5 … wide 1.91:1.
const ratio = p => (p.w && p.h ? Math.min(1.91, Math.max(0.8, p.w / p.h)) : 16 / 9).toFixed(3);

/* ---------- state ---------- */
const POSTS = new Map();   // id → post
const USERS = new Map();   // key → { key, name, avatar, profile }
const FEEDS = [
  { sort: 'trendweek', ids: [], page: 0, more: true, loading: false, error: false, appid: APPID },
  { sort: 'mostrecent', ids: [], page: 0, more: true, loading: false, error: false, appid: APPID },
];
const LIKE_KEY = 'shutterbay.liked.v1';
const liked = new Map(store.get(LIKE_KEY, []).map(e => [e.p.id, e])); // id → { p, u }
for (const { p, u } of liked.values()) { POSTS.set(p.id, p); if (!USERS.has(u.key)) USERS.set(u.key, u); }
let game = GAME_NAMES[APPID] || 'GTA V';

function ingest(it) {
  const u = it.author;
  USERS.set(u.key, u);
  const prev = POSTS.get(it.id);
  const p = { id: it.id, img: it.img, w: it.w, h: it.h, cap: it.cap || '', orig: it.orig || '', tl: !!it.tl,
    votes: it.votes || 0, comments: it.comments || 0, url: it.url, u: u.key, showOrig: prev?.showOrig || false };
  POSTS.set(p.id, p);
  if (liked.has(p.id)) { liked.set(p.id, { p, u }); saveLikes(); }
  return p;
}
const saveLikes = () => store.set(LIKE_KEY, [...liked.values()]);

/* ---------- data ---------- */
async function loadMore(f) {
  if (f.loading || !f.more) return;
  f.loading = true; f.error = false; setFooter(f);
  const fresh = [];
  try {
    const page = f.page + 1;
    const d = await getFeed(f, page);
    f.page = page; f.more = d.more && d.items.length > 0;
    for (const it of d.items) { ingest(it); if (!f.ids.includes(it.id)) { f.ids.push(it.id); fresh.push(it.id); } }
    if (d.pending) fillCaptionsLater(f, page);
  } catch (e) {
    console.warn('feed', e); f.error = true;
  }
  f.loading = false;
  appendPosts(f, fresh);
}
async function getFeed(f, page) {
  const q = new URLSearchParams({ sort: f.sort, page: String(page) });
  if (f.appid) q.set('appid', f.appid);
  if (browserLang) q.set('lang', browserLang);
  const r = await fetch('/api/feed?' + q);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (d.lang && d.lang !== lang) applyLang(d.lang);
  if (d.game) game = d.game;
  return d;
}
// Captions that have never been seen are translated in the background on the
// server; ask again a little later and swap the translated text in place.
function fillCaptionsLater(f, page, tries = 0) {
  setTimeout(async () => {
    try {
      const d = await getFeed(f, page);
      for (const it of d.items) {
        const before = POSTS.get(it.id)?.cap;
        const p = ingest(it);
        if (p.cap !== before) patchCaption(p);
      }
      if (d.pending && tries < 2) fillCaptionsLater(f, page, tries + 1);
    } catch { /* captions stay in the original language */ }
  }, [4000, 9000, 20000][tries]);
}

/* ---------- rendering ---------- */
const HEART_POP = `<svg class="heartpop" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" fill="#fff"/></svg>`;
const avatar = u => (u?.avatar ? `<img src="${esc(u.avatar)}" alt="" loading="lazy">` : '');
function likeBtn(p) {
  const on = liked.has(p.id);
  return `<button data-act="like" class="${on ? 'on' : ''}" aria-pressed="${on}" aria-label="${esc(t(on ? 'unlike' : 'like'))}">${svgI(on ? 'heartF' : 'heart')}<span>${fmt(p.votes + (on ? 1 : 0))}</span></button>`;
}
function postHTML(p, full) {
  const u = USERS.get(p.u) || { name: '' };
  const cap = p.showOrig && p.orig ? p.orig : p.cap;
  return `<article class="post${full ? ' full' : ''}" data-id="${esc(p.id)}">
    <button class="photo" data-act="photo" style="aspect-ratio:${ratio(p)}" aria-label="${esc(t('options'))}">${imgTag(p)}${HEART_POP}</button>
    <div class="meta">
      ${full ? '' : `<button class="who" data-act="profile"><span class="av">${avatar(u)}</span><span>${esc(u.name)}</span></button>`}
      ${cap ? `<button class="cap" data-act="detail">${esc(cap)}</button>` : ''}
      ${full && p.tl ? `<button class="tl" data-act="orig">${esc(t(p.showOrig ? 'show_translation' : 'translated'))}</button>` : ''}
      <div class="acts">
        ${likeBtn(p)}
        <button data-act="comments" aria-label="${esc(t('comments'))}">${svgI('bubble')}<span>${fmt(p.comments)}</span></button>
      </div>
    </div></article>`;
}
const SKELETON = `<div class="post skel" aria-hidden="true"><div class="photo"></div><div class="meta"><div class="line s"></div><div class="line"></div></div></div>`;

let tab = 0;
function footerHTML(f) {
  let html;
  if (f.error) html = `<button class="end err" data-retry>${esc(t('error'))}</button>`;
  else if (!f.ids.length) html = f.more ? SKELETON + SKELETON : `<div class="end">${esc(t('end'))}</div>`;
  else if (f.more) html = `<div class="end">${esc(t('loading'))}</div>`;
  else html = `<div class="end">${esc(t('end'))}</div>`;
  return html + (f.ids.length ? `<div class="fine">${esc(t('fine'))}</div>` : '');
}
// Infinite scroll appends instead of re-rendering, so loaded images stay put.
function setFooter(f, extra = '') {
  if (FEEDS[tab] !== f) return;
  const el = $('#feed');
  el.querySelectorAll(':scope > .end, :scope > .fine, :scope > .skel').forEach(n => n.remove());
  el.insertAdjacentHTML('beforeend', extra + footerHTML(f));
}
function appendPosts(f, ids) {
  if (FEEDS[tab] !== f) return;
  if (!$('#feed .src')) { renderFeed(true); return; }
  const first = f.ids.length === ids.length;
  setFooter(f, ids.map(id => postHTML(POSTS.get(id))).join(''));
  if (first) $('#feed').scrollTop = scrollMem[tab] = 0;   // first page: start at the header
}
function patchCaption(p) {
  document.querySelectorAll(`.post[data-id="${CSS.escape(p.id)}"]`).forEach(art => {
    if (art.classList.contains('full')) { $('#dBody').innerHTML = postHTML(p, true); return; }
    const cap = art.querySelector('.cap');
    if (cap) cap.textContent = p.showOrig && p.orig ? p.orig : p.cap;
  });
}
function renderFeed(keepScroll) {
  const el = $('#feed'); const st = el.scrollTop;
  let html = '';
  if (tab < 2) {
    const f = FEEDS[tab];
    html += `<div class="src"><b>${esc(game)}</b><span>${esc(t('src_' + f.sort))}</span></div>`;
    html += f.ids.map(id => postHTML(POSTS.get(id))).join('');
    html += footerHTML(f);
  } else {
    const list = [...liked.values()].reverse().map(e => e.p);
    html = list.length
      ? list.map(p => postHTML(p)).join('') + `<div class="end">${esc(t('end'))}</div>`
      : `<div class="empty">${esc(t('empty_liked'))}</div>`;
  }
  el.innerHTML = html;
  if (keepScroll) el.scrollTop = st;
  document.querySelectorAll('.tabbar button').forEach((b, i) => {
    const k = ['home', 'eye', 'heart'][i];
    b.firstElementChild.innerHTML = ICON[i === tab ? k + 'F' : k];
    b.setAttribute('aria-current', i === tab ? 'page' : 'false');
  });
  $('#ind').style.transform = `translateX(${tab * 100}%)`;
}
const scrollMem = [0, 0, 0];
function setTab(n) {
  if (n === tab) { $('#feed').scrollTo({ top: 0, behavior: 'smooth' }); return; }
  scrollMem[tab] = $('#feed').scrollTop; tab = n; renderFeed(); $('#feed').scrollTop = scrollMem[n];
  if (n < 2 && !FEEDS[n].page) loadMore(FEEDS[n]);
}
document.querySelectorAll('.tabbar button').forEach(b => { b.onclick = () => setTab(+b.dataset.tab); });

// Infinite scroll: fetch the next page when the reader nears the end.
$('#feed').addEventListener('scroll', () => {
  if (tab > 1) return;
  const el = $('#feed');
  if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight * 1.5) loadMore(FEEDS[tab]);
}, { passive: true });
$('#feed').addEventListener('click', e => { if (e.target.closest('[data-retry]')) loadMore(FEEDS[tab]); });

/* ---------- navigation ---------- */
const stack = [];
function push(id) { const v = $('#' + id); v.style.zIndex = 10 + stack.length; v.classList.remove('off-right'); stack.push(id); }
function pop() { const id = stack.pop(); if (id) $('#' + id).classList.add('off-right'); if (tab === 2 && !stack.length) renderFeed(true); }
document.querySelectorAll('[data-back]').forEach(b => { b.onclick = pop; });

let curPost = null;
function openDetail(id) {
  curPost = id; const p = POSTS.get(id);
  $('#dTitle').textContent = USERS.get(p.u)?.name || '';
  $('#dBody').innerHTML = postHTML(p, true); push('detail');
}
function openProfile(key) {
  const u = USERS.get(key); if (!u) return;
  $('#pTitle').textContent = u.name;
  const posts = [...POSTS.values()].filter(p => p.u === key);
  const votes = posts.reduce((s, p) => s + p.votes, 0);
  $('#pBody').innerHTML = `<div class="prof"><span class="bigav"><span>${avatar(u)}</span></span>
    <div class="stats"><div><b>${fmt(posts.length)}</b><small>${esc(t('stat_shots'))}</small></div><div><b>${fmt(votes)}</b><small>${esc(t('stat_votes'))}</small></div></div></div>
    <p class="bio">${esc(t('bio_steam'))}</p>
    ${u.profile ? `<a class="ext" href="${esc(u.profile)}" target="_blank" rel="noopener">${esc(t('open_profile'))} ↗</a>` : ''}
    <div class="pgrid">${posts.map(p => `<button class="photo" data-pid="${esc(p.id)}" aria-label="${esc(p.cap || t('shot_by', { name: u.name }))}">${imgTag(p)}</button>`).join('')}</div>`;
  $('#pBody').querySelectorAll('[data-pid]').forEach(b => { b.onclick = () => openDetail(b.dataset.pid); });
  push('profile');
}

/* ---------- comments ----------
 * Real Steam comments, read in-app and translated into the reader's language.
 * Writing still happens on Steam, since posting needs the reader's Steam login. */
const EMO = 'https://community.fastly.steamstatic.com/economy/emoticon/';
const withEmoticons = s => esc(s).replace(/:([A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*):/g,
  (m, n) => `<img class="emo" src="${EMO}${n}" alt="${m}" title="${m}">`);
document.addEventListener('error', e => { if (e.target.classList?.contains('emo')) e.target.replaceWith(e.target.alt); }, true);
function ago(sec) {
  if (!sec) return '';
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const d = (sec * 1000 - Date.now()) / 1000;
  for (const [u, s] of [['year', 31536e3], ['month', 2592e3], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(d) >= s) return rtf.format(Math.round(d / s), u);
  }
  return rtf.format(0, 'minute');
}
const cmState = p => (p.cm ??= { pages: {}, total: p.comments, size: 30, loading: false, error: false, loaded: false });
const cmItems = s => Object.keys(s.pages).map(Number).sort((a, b) => b - a).flatMap(k => s.pages[k]);  // oldest page first
const cmOlderStart = s => { const starts = Object.keys(s.pages).map(Number); const next = Math.max(...starts) + s.size; return starts.length && next < s.total ? next : null; };

function openComments(id) {
  curPost = id; const p = POSTS.get(id);
  $('#cWrite').href = p.url;
  renderComments(); push('comments');
  const s = cmState(p);
  if (!s.loaded) loadComments(p, 0, true);
  else requestAnimationFrame(() => { $('#cBody').scrollTop = 9e9; });
}
async function loadComments(p, start, toBottom, tries = 0) {
  const s = cmState(p);
  if (s.loading && tries === 0) return;
  s.loading = true; s.error = false; if (tries === 0) renderComments();
  const el = $('#cBody'); const fromBottom = el.scrollHeight - el.scrollTop;
  try {
    const q = new URLSearchParams({ id: p.id, owner: p.u, start: String(start) });
    if (browserLang) q.set('lang', browserLang);
    const r = await fetch('/api/comments?' + q);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    s.pages[start] = d.comments; s.total = d.total; s.size = d.size || s.size; s.loaded = true;
    if (d.pending && tries < 2) setTimeout(() => { if (curPost === p.id && stack.includes('comments')) loadComments(p, start, false, tries + 1); }, [4000, 10000][tries]);
  } catch (e) {
    console.warn('comments', e); s.error = true;
  }
  s.loading = false;
  if (curPost !== p.id || !stack.includes('comments')) return;
  renderComments();
  // Stay with what the reader was looking at: newest at the bottom on open, same spot otherwise.
  el.scrollTop = toBottom ? 9e9 : el.scrollHeight - fromBottom;
}
function renderComments() {
  const p = POSTS.get(curPost); const s = cmState(p); const items = cmItems(s);
  let html = '';
  if (s.loaded && cmOlderStart(s) !== null) html += `<button class="older" data-older>${esc(t('load_earlier'))}</button>`;
  html += items.map(c => `<div class="cm"><span class="av">${avatar(c.author)}</span><div>
      <b>${esc(c.author.name)}</b><p>${withEmoticons(c.showOrig && c.orig ? c.orig : c.text)}</p>
      <div class="meta2"><time datetime="${c.at ? new Date(c.at * 1000).toISOString() : ''}">${esc(ago(c.at))}</time>${c.tl ? `<button class="tl" data-cmorig="${esc(c.id)}">${esc(t(c.showOrig ? 'show_translation' : 'translated'))}</button>` : ''}</div>
    </div></div>`).join('');
  if (!s.loaded && s.loading) html += Array(4).fill('<div class="cm skel" aria-hidden="true"><span class="av"></span><div><div class="line" style="width:30%"></div><div class="line"></div></div></div>').join('');
  else if (s.error) html += `<button class="end err" data-cmretry>${esc(t('error'))}</button>`;
  else if (s.loaded && !items.length) html += `<div class="empty">${esc(t('no_comments'))}</div>`;
  $('#cBody').innerHTML = html;
}
$('#cBody').addEventListener('click', e => {
  const p = POSTS.get(curPost); if (!p) return;
  const s = cmState(p);
  if (e.target.closest('[data-older]')) { const n = cmOlderStart(s); if (n !== null) loadComments(p, n, false); }
  else if (e.target.closest('[data-cmretry]')) loadComments(p, s.loaded ? cmOlderStart(s) ?? 0 : 0, !s.loaded);
  else {
    const b = e.target.closest('[data-cmorig]'); if (!b) return;
    const c = cmItems(s).find(x => x.id === b.dataset.cmorig);
    if (c) { const el = $('#cBody'), st = el.scrollTop; c.showOrig = !c.showOrig; renderComments(); el.scrollTop = st; }
  }
});

function toggleLike(id, force) {
  const p = POSTS.get(id); if (!p) return false;
  const now = force === undefined ? !liked.has(id) : force;
  if (now) liked.set(id, { p, u: USERS.get(p.u) }); else liked.delete(id);
  saveLikes();
  // Patch the like buttons in place: re-rendering the feed would reload every image.
  document.querySelectorAll(`.post[data-id="${CSS.escape(id)}"] [data-act=like]`).forEach(b => { b.outerHTML = likeBtn(p); });
  if (tab === 2 && !stack.length) renderFeed(true);
  document.querySelectorAll(`.post[data-id="${CSS.escape(id)}"] [data-act=like] svg`).forEach(s => s.classList.add('bump'));
  return now;
}
function refreshDetail() {
  if (stack.includes('detail') && curPost) $('#dBody').innerHTML = postHTML(POSTS.get(curPost), true);
}

/* options sheet */
let sheetPost = null;
function openSheet(id) { sheetPost = id; syncSheet(); $('#sheet').classList.add('open'); }
function syncSheet() {
  const on = liked.has(sheetPost);
  $('#optHeart').innerHTML = ICON[on ? 'heartF' : 'heart'];
  $('#optLikeTxt').textContent = t(on ? 'unlike' : 'like');
}
const closeSheet = () => $('#sheet').classList.remove('open');
$('#sheetClose').onclick = closeSheet;
$('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
$('#optLike').onclick = () => { const v = toggleLike(sheetPost); syncSheet(); toast(t(v ? 'liked_toast' : 'unliked_toast')); setTimeout(closeSheet, 250); };
$('#optCm').onclick = () => { closeSheet(); openComments(sheetPost); };
$('#optPf').onclick = () => { closeSheet(); openProfile(POSTS.get(sheetPost).u); };

/* delegated post actions (feed + detail) */
let lastTap = 0;
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const art = a.closest('.post'); if (!art) return;
  const id = art.dataset.id; const act = a.dataset.act;
  if (act === 'photo') {
    const now = Date.now();
    if (now - lastTap < 300) {
      clearTimeout(a._t); toggleLike(id, true);
      const pop = document.querySelector(`.post[data-id="${CSS.escape(id)}"] .heartpop`);
      if (pop) { pop.classList.remove('go'); void pop.offsetWidth; pop.classList.add('go'); }
      lastTap = 0; return;
    }
    lastTap = now; a._t = setTimeout(() => openSheet(id), 300);
  } else if (act === 'like') toggleLike(id);
  else if (act === 'comments') openComments(id);
  else if (act === 'profile') openProfile(POSTS.get(id).u);
  else if (act === 'detail') { if (!art.classList.contains('full')) openDetail(id); }
  else if (act === 'orig') { const p = POSTS.get(id); p.showOrig = !p.showOrig; refreshDetail(); }
});

/* keyboard: Q/E switch tabs, ↑/↓ step posts, Enter opens options, C opens comments, Esc goes back */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { if ($('#sheet').classList.contains('open')) closeSheet(); else if (stack.length) pop(); }
  if (stack.length || $('#sheet').classList.contains('open')) return;
  if (e.key === 'q' || e.key === 'Q') setTab((tab + 2) % 3);
  if (e.key === 'e' || e.key === 'E') setTab((tab + 1) % 3);
  const f = $('#feed'), posts = [...f.querySelectorAll('.post:not(.skel)')];
  const cur = posts.findIndex(p => p.offsetTop + p.offsetHeight / 2 > f.scrollTop);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = Math.max(0, Math.min(posts.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
    posts[n] && f.scrollTo({ top: posts[n].offsetTop, behavior: 'smooth' });
  }
  if (e.key === 'Enter' && posts[cur]) { e.preventDefault(); openSheet(posts[cur].dataset.id); }
  if ((e.key === 'c' || e.key === 'C') && posts[cur]) openComments(posts[cur].dataset.id);
});
/* swipe right from left edge = back; horizontal swipe on the feed switches tabs */
let sx = null, fx = null, fy = null;
$('#screen').addEventListener('touchstart', e => { const p = e.touches[0]; sx = p.clientX < 30 ? p.clientX : null; fx = p.clientX; fy = p.clientY; }, { passive: true });
$('#screen').addEventListener('touchend', e => {
  const p = e.changedTouches[0];
  if (sx !== null) { const dx = p.clientX - sx; sx = null; if (dx > 70 && stack.length) { pop(); return; } }
  if (fx === null || stack.length || $('#sheet').classList.contains('open')) return;
  const dx = p.clientX - fx, dy = p.clientY - fy; fx = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) { const n = tab + (dx < 0 ? 1 : -1); if (n >= 0 && n < 3) setTab(n); }
}, { passive: true });

let tt;
function toast(m) { const el = $('#toast'); el.textContent = m; el.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), 1500); }

applyLang();
renderFeed();
loadMore(FEEDS[0]);
