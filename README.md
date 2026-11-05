# SMM

<div align="center">

### A self-hosted command center for Instagram and Threads

Schedule content, publish through official Meta APIs, understand performance,
and automate guarded Threads engagement from one dashboard.

<p>
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#documentation">Documentation</a>
</p>

</div>

> **Status:** Scheduling and engagement are live. End-to-end content
> generation is planned. This project is designed for a single creator account.

## Why SMM?

SMM replaces a collection of scripts and dashboards with one focused,
self-hosted workspace for social publishing. It uses Meta's official APIs,
stores operational state in PostgreSQL, and keeps automation bounded with
rate limits, quiet hours, previews, and a global kill switch.

**No scrapers. No browser automation. No unofficial clients.**

## Features

| Area | What you get |
| --- | --- |
| **Publishing** | Schedule Instagram feed, reel, carousel, and story content plus Threads posts and reply chains. |
| **Calendar** | Compose, edit, duplicate, preview, and track content from a visual calendar. |
| **Media** | Upload and serve media through a local disk driver or S3-compatible storage. |
| **Analytics** | Sync insights and explore dashboard metrics, trends, top posts, and engagement patterns. |
| **AI assistance** | Generate captions, hooks, tags, image prompts, and dashboard insights. |
| **Engagement** | Poll Threads comments and prepare guarded replies with human-like scheduling. |
| **Safety** | Daily caps, quiet windows, confidence checks, encrypted tokens, and a kill switch. |

### Delivery status

| Capability | Status |
| --- | --- |
| Scheduling and publishing | ✅ Live |
| Analytics dashboard | ✅ Live |
| Guarded Threads engagement | ✅ Live |
| End-to-end content generation | 🛠 Planned |

## Stack

| Layer | Technology |
| --- | --- |
| Web | Next.js 16, React 19, Tailwind CSS 4 |
| API | Fastify 5, TypeScript, Zod |
| Data | PostgreSQL, Prisma 5 |
| Workers | Postgres polling; no Redis or BullMQ |
| AI | DeepSeek for text, OpenRouter for image description |
| Media | Local disk or S3-compatible storage |
| Deployment | Fly.io, Docker, esbuild |

## Architecture

```text
┌──────────────────────┐       REST        ┌──────────────────────────┐
│  Next.js dashboard   │ ◄───────────────► │  Fastify API             │
│  calendar · compose  │                  │  routes · auth · media   │
│  analytics · settings│                  └────────────┬─────────────┘
└──────────────────────┘                               │
                                                       │
                         ┌─────────────────────────────┼────────────────┐
                         ▼                             ▼                ▼
                   PostgreSQL                  Meta Graph APIs      AI APIs
                 state · schedules             Instagram · Threads  DeepSeek
                 · analytics                  official publishing  OpenRouter
```

In production, the API, publishing worker, and engagement worker run in one
process. In local development, they can be started independently.

## Repository layout

```text
apps/
  api/        Fastify API, publishers, workers, services, and auth
  web/        Next.js dashboard and calendar UI
packages/
  db/         Prisma schema, migrations, and generated client
  shared/     Shared platform rules and types
docs/         Feature guides and operational documentation
scripts/      Local development and deployment helpers
```

## Quick start

### Prerequisites

- Node.js 20+
- pnpm 9+
- PostgreSQL (Supabase works well)
- `cloudflared` for the local public media tunnel
- A Meta developer app with Instagram and Threads testers

### 1. Install

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install
```

### 2. Configure environment

Create `.env` in the repository root. The full schema lives in
[`apps/api/src/env.ts`](./apps/api/src/env.ts).

```dotenv
DATABASE_URL=postgres://...
DIRECT_URL=postgres://...
TOKEN_ENCRYPTION_KEY=<32-byte-base64-value>
PUBLIC_BASE_URL=http://localhost:4000

# Required for production API access
API_AUTH_TOKEN=<long-random-token>
CORS_ORIGINS=http://localhost:3000

THREADS_ACCESS_TOKEN=<long-lived-token>
INSTAGRAM_ACCESS_TOKEN=<long-lived-token>
INSTAGRAM_USER_ID=<instagram-account-id>

DEEPSEEK_API_KEY=<optional>
OPENROUTER_API_KEY=<optional>

KILL_SWITCH=false
ENGAGEMENT_ENABLED=true
```

Keep `.env` out of version control. For a separately hosted dashboard, set
`NEXT_PUBLIC_API_TOKEN` to the same value as `API_AUTH_TOKEN`. Production
requires authentication for every API route except `/health` and the Meta
webhook handshake. Test publishing routes are disabled in production.

### 3. Prepare the database

```bash
pnpm db:generate
pnpm db:migrate
```

### 4. Run locally

```bash
# Start the API, workers, and dashboard with the project launcher
pnpm dev

# Or run individual pieces
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Open `http://localhost:3000`. Check API liveness at
`http://localhost:4000/health`.

### 5. Deploy

```bash
pnpm secrets:push
fly deploy
```

The Fly configuration is in [`fly.toml`](./fly.toml). Set secrets through Fly,
never by committing them to the repository.

## Documentation

- [Scheduling](./docs/SCHEDULING.md) — calendar, media, composition, and publishing
- [Dashboard](./docs/DASHBOARD.md) — analytics and insight generation
- [Agents](./docs/AGENTS.md) — Threads engagement, safety rules, and kill switch
- [Profile](./docs/PROFILE.md) — identity, voice, versioning, and fail-closed behavior
- [Cadence](./docs/CADENCE.md) — time zones, quiet windows, and autonomy controls
- [Visual style](./docs/VISUAL-STYLE.md) — image-prompt vocabulary and taxonomy
- [Testing](./docs/TESTING.md) — test strategy and known gaps
- [Backups](./docs/BACKUPS.md) — encrypted PostgreSQL backups and restore drills
- [Roadmap](./PLAN.md) — planned work and project phases

## Security checklist

Before making a deployment or fork public:

- Confirm `.env` files, database dumps, uploads, tokens, and private keys are
  not tracked.
- Generate unique `API_AUTH_TOKEN` and `TOKEN_ENCRYPTION_KEY` values.
- Restrict `CORS_ORIGINS` to trusted dashboard origins.
- Store production secrets in the hosting provider.
- Review [GitHub's sensitive-data guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
  if a secret was ever committed.

## Contributing

Issues and pull requests are welcome. Please keep changes focused, add or
update tests for behavior changes, and avoid introducing unofficial platform
clients or credential material.

## License

No license has been declared yet. Add a `LICENSE` file before accepting external
contributions or redistributing the project.
