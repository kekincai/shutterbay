// Reads the public Steam Community hub screenshot listing for one app.
// Steam has no JSON API for this view, so we parse the HTML fragment the hub
// itself loads ("homecontent"). Only fields we need leave this module.

export const SORTS = ['trendweek', 'mostrecent', 'trendday', 'toprated'];
export const PER_PAGE = 20;

export async function fetchScreenshots(appid, sort, page, n = PER_PAGE) {
  const url = `https://steamcommunity.com/app/${appid}/homecontent/?screenshotspage=${page}&numperpage=${n}` +
    `&browsefilter=${sort}&appHubSubSection=2&l=english`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Shutterbay; +https://github.com/)', 'Accept-Language': 'en' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Steam responded ${res.status}`);
  return parse(await res.text());
}

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
const pick = (re, s) => { const m = re.exec(s); return m ? m[1] : ''; };
const num = s => Number(String(s).replace(/[^\d]/g, '')) || 0;
// Only pass on links that point at Steam's own hosts.
function safeUrl(u, hosts, keepQuery = false) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' || !hosts.some(h => x.hostname === h || x.hostname.endsWith('.' + h))) return '';
    if (!keepQuery) x.search = '';
    return x.href;
  } catch { return ''; }
}

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; Shutterbay)', 'Accept-Language': 'en' };
export const COMMENTS_PER_PAGE = 30;

/**
 * Comments on one screenshot, newest first.
 * `owner` is the author key from the feed ("profiles/7656…" or "id/vanity"); vanity
 * names need one extra request to find the numeric id the comment API wants.
 */
export async function fetchComments(id, owner, start = 0, count = COMMENTS_PER_PAGE) {
  let ownerId = /^profiles\/(\d{17})$/.exec(owner || '')?.[1];
  if (!ownerId) {
    const res = await fetch(`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}&l=english`, { headers: UA });
    if (!res.ok) throw new Error(`Steam responded ${res.status}`);
    ownerId = /"owner":"(\d{17})"/.exec(await res.text())?.[1];
    if (!ownerId) throw new Error('comment thread not found');
  }
  const res = await fetch(
    `https://steamcommunity.com/comment/PublishedFile_Public/render/${ownerId}/${id}/?start=${start}&count=${count}&l=english`,
    { headers: UA },
  );
  if (!res.ok) throw new Error(`Steam responded ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error('Steam comment API failed');
  return { total: Number(d.total_count) || 0, start, comments: parseComments(d.comments_html || '') };
}

export function parseComments(html) {
  const out = [];
  for (const block of html.split(/class="commentthread_comment /).slice(1)) {
    const id = pick(/id="comment_(\d+)"/, block);
    if (!id) continue;
    const author = /commentthread_author_link"\s+href="([^"]+)"[^>]*>\s*<bdi>([\s\S]*?)<\/bdi>/.exec(block) || [];
    const body = pick(/class="commentthread_comment_text"[^>]*>([\s\S]*?)<\/div>/, block)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, ' $1 ')   // Steam emoticons → ":name:"
      .replace(/<[^>]*>/g, '');
    const text = body.split('\n').map(decode).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
    if (!text) continue;
    out.push({
      id,
      text,
      at: Number(pick(/data-timestamp="(\d+)"/, block)) || 0,
      author: {
        name: (decode(author[2] || '').replace(/<[^>]*>/g, '') || 'Steam player').slice(0, 64),
        profile: safeUrl(decode(author[1] || ''), ['steamcommunity.com']),
        avatar: safeUrl(decode(pick(/<a href="[^"]+" data-miniprofile="\d+">\s*<img src="([^"]+)"/, block)), ['steamstatic.com']),
      },
    });
  }
  return out;
}

export function parse(html) {
  const out = [];
  for (const card of html.split(/<div[^>]+class="apphub_Card /).slice(1)) {
    const id = pick(/data-publishedfileid="(\d+)"/, card);
    if (!id) continue;
    const img = /class="apphub_CardContentPreviewImage" src="([^"]+)"(?: width="(\d+)" height="(\d+)")?/.exec(card);
    const base = img && safeUrl(decode(img[1]), ['steamusercontent.com']);
    if (!base) continue;
    const author = /apphub_CardContentAuthorName[^>]*>\s*<a href="([^"]+)">([^<]*)<\/a>/.exec(card) || [];
    const profile = safeUrl(decode(author[1] || ''), ['steamcommunity.com']);
    out.push({
      id,
      img: base,                       // resize on the client with ?imw=
      w: img[2] ? +img[2] : 0,
      h: img[3] ? +img[3] : 0,
      title: decode(pick(/apphub_CardContentTitle[^"]*">([\s\S]*?)<\/div>/, card).replace(/<[^>]*>/g, '')).slice(0, 500),
      votes: num(pick(/apphub_CardRating[^"]*">\s*([\d,]+)/, card)),
      comments: num(pick(/apphub_CardCommentCount">\s*([\d,]+)/, card)),
      author: {
        key: profile ? profile.replace(/^https:\/\/steamcommunity\.com\//, '').replace(/\/$/, '') : 'anon-' + id,
        name: (decode(author[2] || '') || 'Steam player').slice(0, 64),
        avatar: safeUrl(decode(pick(/appHubIconHolder[^"]*"><img src="([^"]+)"/, card)), ['steamstatic.com', 'steamcommunity.com']),
        profile,
      },
      url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + id,
    });
  }
  return out;
}
