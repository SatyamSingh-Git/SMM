# Local infrastructure

Stage 1 needs **Postgres** (for posts/accounts) and **Redis** (for the BullMQ publish queue). Pick whichever option is easier on your machine.

## Option A — Docker (if installed)

```bash
docker compose -f infra/docker-compose.yml up -d
```

Then in your `.env`:

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/smm
REDIS_URL=redis://localhost:6379
```

## Option B — Free-tier cloud (no Docker needed)

Recommended for this project since you wanted a $0 setup.

### Postgres — Supabase free tier
1. Sign up at https://supabase.com (no card needed).
2. Create a new project. Wait ~1 min for it to provision.
3. Settings → Database → **Connection string** → "URI" (Transaction Pooler) → copy.
4. Paste into `.env` as `DATABASE_URL`. It will look like:
   `postgres://postgres.<ref>:<pwd>@<host>.pooler.supabase.com:6543/postgres`

> Note: Supabase free Postgres pauses after 7 days of inactivity. One ping per week keeps it alive.

### Redis — Upstash free tier
1. Sign up at https://upstash.com (no card needed).
2. Create a Redis database. Choose the region closest to your Supabase project.
3. Copy the **TLS connection string** (starts with `rediss://`).
4. Paste into `.env` as `REDIS_URL`.

> Free tier: 10,000 commands/day, plenty for one account.

## Option C — Native installs on Windows

If you want everything local without Docker:

- **Postgres**: https://www.postgresql.org/download/windows/ (use the EnterpriseDB installer)
- **Redis**: Memurai (Windows-native Redis) https://www.memurai.com/get-memurai — free Developer edition

Then set:
```
DATABASE_URL=postgres://postgres:<pwd>@localhost:5432/smm
REDIS_URL=redis://localhost:6379
```

---

After whichever option you picked, run:
```bash
pnpm db:generate
pnpm db:migrate
```
to apply the schema.
