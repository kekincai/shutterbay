# Shutterbay

**Trending Steam Community screenshots as a phone-style photo feed — with captions and comments translated into the reader's language automatically.**

English · [简体中文](README.zh-CN.md)

Shutterbay shows what players are sharing from a game's Steam Community hub (GTA V today, any Steam game by config) in a clean, mobile-first feed: trending and latest tabs, double-tap to like, profiles, and in-app comments. Every caption and comment appears in your language — picked from your browser settings, or from your country when the browser doesn't name a language we support.

It runs entirely on Cloudflare's **free** plan: one Worker, one D1 database, Workers AI and a Cron Trigger. No servers, no API keys to manage.

> Not affiliated with Valve, Steam or Rockstar Games. Screenshots and comments belong to their authors; every post links back to its Steam page.

## Features

- **Steam screenshot feed** — *Trending this week* and *Latest*, with infinite scroll and the real aspect ratio of each shot.
- **Automatic translation** — captions are pre-translated into 10 languages; comments are translated into the reader's language on first view. A *Machine translated · See original* toggle is always one tap away. No translate button.
- **Language detection** — `?lang=` override → browser language (`Accept-Language`) → visitor country (Cloudflare IP geolocation) → English.
- **10 UI languages** — English, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português (Brasil), Русский.
- **In-app comments** — real Steam comments with Steam emoticons, newest at the bottom, *load earlier* on demand.
- **Likes** — saved in the browser (no account needed).
- **Fast and cheap** — listing pages are cached in D1 and refreshed by cron, so visitors almost never wait on Steam or the model.

## How it works

```
Browser ──▶ Cloudflare Worker ──┬─▶ static files (public/)
                                ├─▶ /api/feed      ──▶ D1 cache ──(stale)──▶ steamcommunity.com
                                ├─▶ /api/comments  ──▶ D1 cache ──(stale)──▶ steamcommunity.com
                                └─▶ Workers AI (translation, in the background)
Cron, every 30 min ──▶ refresh first pages + pre-translate new captions
```

| Piece | Where | Notes |
| --- | --- | --- |
| Page | `public/` | Plain HTML/CSS/JS modules, no build step. |
| Language rules | `public/lang.js` | Shared by the page and the Worker. |
| UI strings | `public/i18n.js` | Hand-maintained — PRs for new languages welcome. |
| Worker | `src/worker.js` | Routes, language resolution, cron. |
| Steam reader | `src/steam.js` | Parses the hub's own HTML fragments; only Steam-hosted URLs are passed on. |
| Translation | `src/translate.js` | One model call per caption (all languages); one call per comment batch (one language). |
| Storage | `src/db.js` | Tables are created on first use — no migration step. |

### Staying inside the free plan

| Resource | Free allowance | Shutterbay's use |
| --- | --- | --- |
| Workers requests | 100,000 / day | ~3–5 per visit |
| D1 | 5M reads, 100k writes / day | tens of rows per request; one row per translation |
| Workers AI | 10,000 Neurons / day | capped by `AI_DAILY_CALLS` (default 600 ≈ 8k Neurons) |
| Cron Triggers | 5 per account | 1 |

Each distinct caption or comment is translated **once** and stored, no matter how many people read it. When the daily AI cap is reached, text simply shows in its original language until the next UTC day.

## Deploy

You need a Cloudflare account (free) and Node.js 20+.

### Option A — from your machine

```bash
git clone https://github.com/<you>/shutterbay && cd shutterbay
npm install
npx wrangler login
npx wrangler deploy
```

The D1 database is created automatically on the first deploy. Without a `routes` entry your site is live at `https://shutterbay.<your-subdomain>.workers.dev`.

### Option B — GitHub Actions

1. Create an API token at **Cloudflare dashboard → My Profile → API Tokens** using the *Edit Cloudflare Workers* template, and add **D1: Edit** and **Workers AI: Read** permissions.
2. In your GitHub repo, add secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Push to `main`. The workflow in `.github/workflows/deploy.yml` deploys on every push.

### Use your own subdomain

Your domain must be on Cloudflare (any plan, including Free). Set the `routes` line at the bottom of `wrangler.jsonc` to your hostname (forks: change it, or delete it to stay on `workers.dev`):

```jsonc
"routes": [{ "pattern": "shots.example.com", "custom_domain": true }]
```

Deploy again — Cloudflare creates the DNS record and certificate for you. (You can also add it in the dashboard under **Workers & Pages → shutterbay → Settings → Domains & Routes**.)

## Configuration

All settings are `vars` in `wrangler.jsonc`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STEAM_APPIDS` | `3240220` | Comma-separated Steam app ids. The first is the default feed; others are reachable with `?appid=`. Only listed ids are served. |
| `TRANSLATE_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | Any Workers AI chat model that can return JSON. |
| `AI_DAILY_CALLS` | `600` | Hard cap on model calls per UTC day. |
| `CRON_TRANSLATIONS` | `20` | New captions pre-translated per cron run. |

**Switching to GTA VI** (once it has a Steam page): put its app id first in `STEAM_APPIDS` and add its name to `GAMES` in `src/worker.js`. Nothing else changes.

## Develop

```bash
npm install
npm run dev          # http://localhost:8787
npm run cron         # in another terminal: run the scheduled refresh once
```

`wrangler dev` keeps D1 local (`.wrangler/`), but **Workers AI always runs on Cloudflare**, so translations in development use your account's free allocation. Run `npx wrangler login` first.

Useful URLs while developing: `/?lang=ja` (force a language), `/api/feed?sort=mostrecent&page=2`, `/api/comments?id=<publishedfileid>&owner=profiles/<steamid64>`.

## Contributing

Issues and PRs are welcome — especially new UI languages (`public/i18n.js` + `public/lang.js`), better caption prompts, and accessibility fixes. Please keep the page dependency-free and the Worker inside the free plan.

`docs/prototype.html` is the original static design prototype the app grew from.

## License

[MIT](LICENSE)
