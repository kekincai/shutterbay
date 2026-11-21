# Shutterbay

**把 Steam 社区的热门游戏截图做成手机风格的照片流，配文和评论会自动翻译成读者的语言。**

[English](README.md) · 简体中文

Shutterbay 展示玩家在某个游戏的 Steam 社区里分享的截图。现在是 GTA V，改配置就能换成任何 Steam 游戏。界面是移动端优先的照片流：有"热门"和"最新"两个标签页，双击点赞，可以看作者档案，评论在站内阅读。所有配文和评论都会显示成你的语言，语言优先按浏览器设置选；浏览器里没有支持的语言时，按访问者所在国家选。

整个项目只用 Cloudflare **免费套餐**：一个 Worker、一个 D1 数据库、Workers AI 和一个定时任务（Cron Trigger）。不需要服务器，也不用管理 API key。

> 本项目与 Valve、Steam、Rockstar Games 无关。截图和评论归原作者所有，每条帖子都链接回它的 Steam 页面。

## 功能

- **Steam 截图流**：分"本周热门"和"最新"两个标签页，无限滚动，按每张截图的真实比例显示。
- **自动翻译**：配文会预先翻译成 10 种语言；评论在第一次被打开时，翻译成读者的语言。随时可以点"机器翻译 · 查看原文"看原文，不需要手动点翻译。
- **语言识别**：`?lang=` 参数 → 浏览器语言（`Accept-Language`）→ 访问者所在国家（Cloudflare 的 IP 地理位置）→ 英语。
- **10 种界面语言**：English、简体中文、繁體中文、日本語、한국어、Español、Français、Deutsch、Português (Brasil)、Русский。
- **站内评论**：显示 Steam 上的真实评论，支持 Steam 表情。最新的评论在最下面，更早的评论按需加载。发表评论需要登录 Steam，所以会跳转到 Steam 页面。
- **点赞**：保存在浏览器本地，不需要注册账号。
- **又快又省**：列表页缓存在 D1 里，由定时任务刷新，访客几乎不用等 Steam 或模型返回。

## 架构

```
浏览器 ──▶ Cloudflare Worker ──┬─▶ 静态文件 (public/)
                               ├─▶ /api/feed      ──▶ D1 缓存 ──(过期时)──▶ steamcommunity.com
                               ├─▶ /api/comments  ──▶ D1 缓存 ──(过期时)──▶ steamcommunity.com
                               └─▶ Workers AI（后台翻译）
Cron 每 30 分钟 ──▶ 刷新前几页，并预翻译新出现的配文
```

### 免费额度

| 资源 | 免费额度 | 本项目用量 |
| --- | --- | --- |
| Workers 请求 | 10 万次/天 | 每次访问约 3–5 次 |
| D1 | 读 500 万行、写 10 万行/天 | 每个请求读几十行；每条翻译写 1 行 |
| Workers AI | 1 万 Neurons/天 | 由 `AI_DAILY_CALLS` 限制（默认 600 次，约 8 千 Neurons） |
| Cron Triggers | 每个账号 5 个 | 1 个 |

同一条配文或评论只翻译**一次**，结果存起来，之后不管多少人看都不会再调用模型。如果当天的模型调用次数到了上限，没翻译的内容就先显示原文，等 UTC 第二天额度重置。

## 部署

需要一个 Cloudflare 账号（免费）和 Node.js 20 以上版本。

### 方式 A：本机部署

```bash
git clone https://github.com/<you>/shutterbay && cd shutterbay
npm install
npx wrangler login
npx wrangler deploy
```

第一次部署时会自动创建 D1 数据库。如果没有配置 `routes`，部署完成后访问 `https://shutterbay.<你的子域>.workers.dev`。

### 方式 B：GitHub Actions 自动部署

1. 在 **Cloudflare 控制台 → My Profile → API Tokens** 用 *Edit Cloudflare Workers* 模板创建一个 token，再额外加上 **D1: Edit** 和 **Workers AI: Read** 权限。
2. 在 GitHub 仓库的 Settings → Secrets 里添加 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。
3. 之后每次 push 到 `main` 分支，`.github/workflows/deploy.yml` 都会自动部署。

### 绑定自己的子域名

域名需要托管在 Cloudflare 上（免费套餐也可以）。把 `wrangler.jsonc` 最后那行 `routes` 改成你的子域名。fork 的人要么改成自己的域名，要么删掉这行继续用 `workers.dev`：

```jsonc
"routes": [{ "pattern": "shots.example.com", "custom_domain": true }]
```

重新部署一次，Cloudflare 会自动创建 DNS 记录和证书。也可以在控制台的 **Workers & Pages → shutterbay → Settings → Domains & Routes** 里添加。

## 配置

所有配置项都在 `wrangler.jsonc` 的 `vars` 里：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `STEAM_APPIDS` | `3240220` | Steam app id，多个用逗号分隔。第一个是默认显示的游戏，其他的用 `?appid=` 访问。只会返回这里列出的游戏。 |
| `TRANSLATE_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | 任意能输出 JSON 的 Workers AI 对话模型。 |
| `AI_DAILY_CALLS` | `600` | 每个 UTC 日最多调用模型的次数。 |
| `CRON_TRANSLATIONS` | `20` | 每次定时任务最多预翻译多少条新配文。 |

**换成 GTA VI**（等它上了 Steam 之后）：把它的 app id 放在 `STEAM_APPIDS` 第一个，再在 `src/worker.js` 的 `GAMES` 里加上游戏名，其他都不用改。

## 本地开发

```bash
npm install
npm run dev          # http://localhost:8787
npm run cron         # 在另一个终端运行，手动触发一次定时刷新
```

`wrangler dev` 用的是本地 D1（数据存在 `.wrangler/` 目录），但 **Workers AI 始终跑在 Cloudflare 上**，所以本地开发时的翻译也会消耗你账号的免费额度。运行前先执行 `npx wrangler login`。

调试时常用的地址：`/?lang=ja`（指定语言）、`/api/feed?sort=mostrecent&page=2`、`/api/comments?id=<publishedfileid>&owner=profiles/<steamid64>`。

## 参与贡献

欢迎提 Issue 和 PR，特别是：新增界面语言（改 `public/i18n.js` 和 `public/lang.js`）、改进翻译提示词、无障碍改进。请保持页面不依赖第三方库，Worker 不超出免费额度。

`docs/prototype.html` 是项目最早的静态设计原型。

## 许可证

[MIT](LICENSE)
