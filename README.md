# SMM

> A self-hosted Instagram and Threads scheduler with analytics and guarded
> autonomous engagement.

SMM is a TypeScript monorepo built around Meta's official APIs. It provides a
calendar, composer, publishing workers, analytics, media handling, and an
optional Threads reply system with rate limits, quiet hours, and a kill switch.
It does **not** use scrapers, browser automation, or unofficial clients.

## Documentation

The README is the quick start. Detailed guides live in [`docs/`](./docs):

- **[docs/SCHEDULING.md](./docs/SCHEDULING.md)** — the content calendar, the composer, media upload, AI caption assist, and how a post goes from draft → published.
- **[docs/DASHBOARD.md](./docs/DASHBOARD.md)** — every analytics card, where its numbers come from, and the insights AI layer.
- **[docs/AGENTS.md](./docs/AGENTS.md)** — the autonomous Threads auto-reply system (Stage 2): polling, the persona, scheduling, safety rules, and the kill switch.
- **[docs/PROFILE.md](./docs/PROFILE.md)** — the Profile: who the account is, kept in the database instead of the code. Voice, identity, placeholders, versioning, and the fail-closed rule.
- **[docs/VISUAL-STYLE.md](./docs/VISUAL-STYLE.md)** — the image-prompt vocabulary as data: dimensions, soft deletes, tone bias, and why a `.default()` is not a migration.
- **[docs/CADENCE.md](./docs/CADENCE.md)** — when the account acts (timezone, quiet windows, DST), what the platforms allow (one shared rules table), and the autonomy dial.
- **[docs/TESTING.md](./docs/TESTING.md)** — the test suite, what it pins, how each suite was mutation-verified, and the gaps that are known rather than solved.
- **[docs/BACKUPS.md](./docs/BACKUPS.md)** — encrypted `pg_dump` to R2: scheduling, retention, and how to restore without any SMM code running.
- **[PLAN.md](./PLAN.md)** — the roadmap to a fully autonomous, fully configurable product. Phase status lives there.

## Highlights

- Schedule Instagram feed, reel, carousel, story, and Threads content.
- Publish reliably through Postgres-backed workers without Redis or BullMQ.
- Manage media, profiles, captions, prompts, locations, and style options.
- Track dashboard analytics and generate optional AI-assisted insights.
- Run guarded Threads engagement with daily caps, quiet windows, previews,
  retries, and a global kill switch.
- Encrypt stored access tokens with AES-256-GCM.

---

## Feature status

| Stage | What | Status |
|---|---|---|
| **1 — Scheduling** | Compose + schedule IG (feed/reel/carousel/story) and Threads (post / reply-chain) content; publish on time; recover from failures. | ✅ **Live** |
| **2 — Engagement** | Autonomously reply to comments on your Threads posts in your own voice, on a human-like schedule, with hard safety rules + a kill switch. | ✅ **Live** |
| **3 — Generation** | Generate the content itself end-to-end. | ⬜ Not started |

There is also a **Stage 1.5 analytics layer** (insights sync + dashboard) on top
of Stage 1.

---

## Tech stack

- **Monorepo:** pnpm workspaces (`apps/*`, `packages/*`), TypeScript everywhere, Node ≥ 20.
- **API:** Fastify 5 (`apps/api`). One HTTP server + two background runners (publish + engagement).
- **Web:** Next.js 16 (App Router) + React 19 + Tailwind v4 + FullCalendar + TanStack Query + lucide icons (`apps/web`).
- **DB:** PostgreSQL (Supabase) via Prisma 5 (`packages/db`).
- **Queue:** **none** — both runners poll Postgres directly (no Redis/BullMQ; see note below).
- **AI:** **DeepSeek** (`deepseek-chat`) for all text generation; **OpenRouter** (`qwen/qwen3-vl-32b-instruct`) for image description only. (Claude was dropped on cost.)
- **Media storage:** local-disk driver, served at `/media/*`. Public HTTPS via Cloudflare Tunnel (dev) or the Fly URL (prod).
- **Hosting:** Fly.io single 256 MB machine (`smm-personal`), esbuild-bundled to fit. Migrations run via Fly's `release_command`.

> **No Redis.** The system originally used BullMQ on Upstash Redis. It was removed to eliminate recurring cost — the publish runner ([apps/api/src/worker.ts](apps/api/src/worker.ts)) and the engagement runner ([apps/api/src/engagement-worker.ts](apps/api/src/engagement-worker.ts)) now poll Postgres on a fixed interval. `REDIS_URL` is an ignored, optional leftover env var.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────┐
│  apps/web (Next.js)   Calendar · Composer · Dashboard      │
└───────────────────────────┬──────────────────────────────┘
                            │ REST (fetch, lib/api.ts)
┌───────────────────────────┴──────────────────────────────┐
│  apps/api (Fastify)                                        │
│   routes/  posts · dashboard · engagement · media · ai …   │
│   publishers/  instagram.ts · threads.ts  (Meta APIs)      │
│   worker.ts            publish runner   (polls every 30s)  │
│   engagement-worker.ts reply + comment poller + style      │
│   services/  posts · engagement · reply-generator · …      │
└───────────────────────────┬──────────────────────────────┘
              ┌──────────────┼───────────────┐
              ▼              ▼                ▼
        Postgres        DeepSeek /        Meta APIs
        (Supabase)      OpenRouter        graph.instagram.com
                        (AI)              graph.threads.net
```

The HTTP API and the two runners share one process in production ([apps/api/src/prod.ts](apps/api/src/prod.ts)); in dev they run as separate windows.

---

## Repo layout

```
apps/
  api/                  Fastify HTTP API + the two Postgres-polling runners
    src/
      routes/           HTTP endpoints (posts, dashboard, engagement, media, ai, accounts, locations, webhooks, health, test)
      publishers/       instagram.ts, threads.ts — Meta API adapters
      services/         business logic (posts, engagement, reply-*, dashboard-*, insights-sync, backfill, style-learning, token-refresh, rate-limiter, ai)
      worker.ts         publish runner (scheduled posts → Meta) + token refresh loop
      engagement-worker.ts  reply runner + comment poller + style learning
      server.ts         builds the Fastify app
      prod.ts           production entrypoint (API + both runners in one process)
      env.ts            zod-validated environment schema (the source of truth for all env vars)
      crypto.ts         AES-256-GCM token encryption
      storage.ts        local-disk media driver
  web/                  Next.js dashboard + calendar UI
    app/                page.tsx (calendar), dashboard/page.tsx, layout, providers
    components/         compose-dialog, calendar-view, right-rail, engagement-panel, dashboard/*
    lib/                api.ts (typed API client), types.ts, utils.ts, image-convert.ts
packages/
  db/                   Prisma schema + migrations + generated client (@smm/db)
scripts/                dev.ps1 (launcher), stop.ps1, deploy-secrets.ps1  (PowerShell / Windows)
Dockerfile              production image (esbuild bundle, runs prod.ts)
fly.toml                Fly.io deploy config (256MB, release_command runs migrations)
```

---

## Quick start

### Prerequisites
- Node ≥ 20, pnpm 9+ (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- A Postgres database (Supabase free tier works)
- `cloudflared` on PATH (for the dev launcher — gives Meta a public HTTPS URL to fetch media)
- A Meta developer app with your IG + Threads accounts added as testers (no App Review needed for your own accounts). See the *Meta setup* section below.

### 1. Install dependencies

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install
```

### 2. Configure `.env` (repo root)
All variables are validated in [apps/api/src/env.ts](apps/api/src/env.ts). The essentials:

```
DATABASE_URL=postgres://…           # Supabase pooled connection
DIRECT_URL=postgres://…             # Supabase direct connection (migrations)
TOKEN_ENCRYPTION_KEY=…              # 32 bytes base64: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
PUBLIC_BASE_URL=http://localhost:4000   # auto-rewritten to the tunnel URL by the dev launcher
API_AUTH_TOKEN=…                    # required for protected API routes
CORS_ORIGINS=http://localhost:3000  # comma-separated trusted dashboard origins

THREADS_ACCESS_TOKEN=…              # long-lived Threads token (account auto-seeded on boot)
INSTAGRAM_ACCESS_TOKEN=…            # long-lived IG token
INSTAGRAM_USER_ID=…                 # IG business account id (for /test/instagram only)

DEEPSEEK_API_KEY=…                  # text generation (captions, replies, dashboard AI)
OPENROUTER_API_KEY=…                # vision (from-image caption mode) — optional

META_WEBHOOK_VERIFY_TOKEN=…         # only needed if you wire up webhooks
KILL_SWITCH=false                   # set true to halt ALL publishing + replying
ENGAGEMENT_ENABLED=true             # set false to disable the auto-reply runner in prod
```
For a separately hosted dashboard, set `NEXT_PUBLIC_API_TOKEN` to the same value
as `API_AUTH_TOKEN`. Keep `.env` out of version control. Test publishing routes
are disabled in production. `/health` and the Meta webhook handshake remain
unauthenticated; all other API routes require a Bearer token.

`REDIS_URL` is accepted but ignored as a legacy variable. The complete schema
and defaults are documented in [env.ts](apps/api/src/env.ts).

### 3. Generate the database client and migrate
```bash
pnpm db:generate     # generate the Prisma client
pnpm db:migrate      # apply migrations to your DATABASE_URL
```

### 4. Run locally
The one-shot launcher (Windows / PowerShell) starts a Cloudflare Tunnel, writes its URL into `PUBLIC_BASE_URL`, and opens three windows (API :4000, publish worker, web :3000):
```bash
pnpm dev
```
Or run pieces individually:
```bash
pnpm dev:api          # Fastify API on :4000 (HTTP only — no background runners)
pnpm dev:worker       # publish runner (worker.ts) + token refresh
pnpm dev:web          # Next.js dashboard on :3000
pnpm --filter @smm/api engagement-worker   # auto-reply runner (NOT started by `pnpm dev`)
```
> In local dev, `pnpm dev` does **not** start the engagement (auto-reply) runner — run it explicitly if you want auto-replies locally. In production both runners always run inside one process.

Open `http://localhost:3000` for the UI and `http://localhost:4000/health` to sanity-check the API.

### 5. Deploy (Fly.io)
```bash
pnpm secrets:push     # push .env values to Fly secrets (skips dev-only vars)
fly deploy            # builds the image, runs migrations (release_command), swaps the machine
```
Production runs at `https://smm-personal.fly.dev`. Health: `/health`.

---

## Meta setup (one-time, manual)

1. **Instagram → Professional account** (Business or Creator), linked to a Facebook Page.
2. **Meta developer app** at developers.facebook.com → add the **Instagram** + **Threads** products.
3. **Add yourself as a tester** — tester accounts use the publishing/comment scopes without App Review.
4. **Scopes:** IG — `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`; Threads — `threads_basic`, `threads_content_publish`, `threads_manage_replies`, `threads_read_replies`.
5. Generate **long-lived tokens** and paste them into `.env` (`THREADS_ACCESS_TOKEN`, `INSTAGRAM_ACCESS_TOKEN`). On boot the API seeds an `Account` row per token and auto-refreshes them ≥7 days before the 60-day expiry ([token-refresh.ts](apps/api/src/services/token-refresh.ts)).

Meta's published limits the system respects (with a ~20% safety margin, enforced in [rate-limiter.ts](apps/api/src/services/rate-limiter.ts)): IG 100 publishes/24h (we cap 80), 50 carousels/24h (cap 40); Threads 250 posts/24h (cap 200), 1000 replies/24h (cap 800). Auto-replies have an additional self-imposed cap of 300/day.

---

## Security and operations

- **Kill switch:** `KILL_SWITCH=true` halts outbound publishing and replying immediately.
- **API authentication:** production requires `API_AUTH_TOKEN`; CORS is restricted
  by `CORS_ORIGINS`.
- **Only official APIs.** No Selenium / instagrapi / scrapers — those get accounts banned.
- **Encrypted tokens.** Access tokens are AES-256-GCM encrypted at rest ([crypto.ts](apps/api/src/crypto.ts)).
- **Engagement guardrails.** Hard content rules, daily caps, IST quiet windows, and a confidence-based skip path — all detailed in [docs/AGENTS.md](./docs/AGENTS.md).

Before making a fork or deployment public:

1. Confirm no `.env` files, database dumps, uploads, tokens, or private keys are
   tracked.
2. Set production secrets through the hosting provider, not in this repository.
3. Generate a unique `API_AUTH_TOKEN` and `TOKEN_ENCRYPTION_KEY`.
4. Restrict `CORS_ORIGINS` to the actual dashboard origin.
5. Review [GitHub's sensitive-data guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
   if any secret was ever committed.

## License

No license has been declared yet. Add a `LICENSE` file before accepting external
contributions or redistributing the project.
