# SMM — Autonomy Plan

**Goal:** one product that runs an Instagram + Threads presence end-to-end — plans, generates, schedules, publishes, replies, learns — where *nothing about the creator, the genre, the voice, the visuals, the cadence, or the safety rules is hardcoded*. Every one of those is data, editable at runtime. The code carries only mechanism.

**Scope decision (locked):** single personal account for now. No auth, no orgs, no billing. But every phase below is built so the config layer is keyed by a `Profile` row rather than a singleton — adding tenancy later is "add a `userId` FK and a session guard", not a rewrite. We build the *flow*, not the tenancy.

**Non-goal:** platforms beyond IG + Threads. `Platform` stays a 2-value Prisma enum.

---

## Part I — Where we actually are

18,590 lines of TS/TSX/Prisma. Stage 1 (scheduling) and Stage 2 (Threads auto-reply) are live on a 256 MB Fly machine — migrating in Phase 0.5 to two Oracle Always Free micro instances (1 GB each), which raises the per-process ceiling 4× and, more importantly, lets the publisher and the risky work run on separate hosts. Stage 3 (generation) does not exist.

### The hardcoding inventory

The complete list of what must move from code to data. All verified in the current tree.

**1. Identity + voice — 6 prompt constants, all naming one specific handle**

| Location | What |
|---|---|
| [ai.ts:183](apps/api/src/services/ai.ts#L183) `BRAND_VOICE` | caption voice; names the handle, age, nationality, gender, posting context |
| [ai.ts:354](apps/api/src/services/ai.ts#L354) `BRAND_VOICE_VISUAL_FALLBACK` | physical-appearance descriptor block that locks identity across generated images |
| [reply-generator.ts:11](apps/api/src/services/reply-generator.ts#L11) `SYSTEM_PROMPT` | ~200 lines: personality traits, forbidden-word lists, language rules, gender-of-voice, skip triggers |
| [dashboard-ai.ts:49](apps/api/src/services/dashboard-ai.ts#L49) | strategist prompt; names handle + niche |
| [dashboard-caption-patterns.ts:39](apps/api/src/services/dashboard-caption-patterns.ts#L39) | analyst prompt; names handle + niche |
| [dashboard-comment-themes.ts:36](apps/api/src/services/dashboard-comment-themes.ts#L36) | audience prompt; hardcodes the *audience demographic* |

Consumed at [ai.ts:564,613,657](apps/api/src/services/ai.ts#L564), [image-prompts.ts:681](apps/api/src/services/image-prompts.ts#L681), [inspire.ts:98](apps/api/src/services/inspire.ts#L98), [reply-generator.ts:317](apps/api/src/services/reply-generator.ts#L317).

**2. Visual taxonomy — 9 hardcoded key unions, ~80 catalog entries** in [image-prompts.ts](apps/api/src/services/image-prompts.ts): `OutfitKey` (13 values, one culture's fashion), `ShotTypeKey`, `CameraQualityKey`, `PhotographerKey`, `CameraAngleKey`, `LocaleKey` (10 values, one country), `LightingKey`, `HairstyleKey`. Surfaced to the UI via `getOptionCatalog()` at [image-prompts.ts:813](apps/api/src/services/image-prompts.ts#L813). A creator in another genre shares approximately none of these.

**3. Cadence — timezone is a compile-time constant.** [reply-schedule.ts:23](apps/api/src/services/reply-schedule.ts#L23) `IST_OFFSET_MIN = 5*60+30` with an explicit "no DST" assumption. `QUIET_WINDOWS_IST` at [line 30](apps/api/src/services/reply-schedule.ts#L30) is a fixed array. Session bands `MORNING_BAND`/`EVENING_BAND` in [runtime-config.ts](apps/api/src/services/runtime-config.ts) are commented "fixed by the system (not user-editable)" and duplicated as validation constants in [settings.ts:7-10](apps/api/src/routes/settings.ts#L7).

**4. Platform policy is scattered literals.** Caption caps (2200/500) and carousel bounds live in `TYPE_CONFIG` at [compose-dialog.tsx:67](apps/web/components/compose-dialog.tsx#L67) *and* are re-checked server-side. First-line cutoffs (55/125) and the bait-phrase list live in [caption-lint.ts](apps/web/lib/caption-lint.ts). Two sources of truth, both in code.

**5. Engagement is Threads-only, hardcoded.** [engagement.ts](apps/api/src/services/engagement.ts) filters `where: { platform: "threads" }` in both pollers and stamps `platform: "threads"` on every insert. It imports only `publishers/threads.js`. Instagram comments are never ingested, never replied to.

**6. Webhooks are a 33-line stub.** [webhooks.ts](apps/api/src/routes/webhooks.ts) — GET handshake works, POST logs and acks with a `TODO Stage 2`. No signature verification.

### What already exists and must be reused, not rebuilt

- `AppSettings` + [runtime-config.ts](apps/api/src/services/runtime-config.ts) — the config-cache pattern is **correct**. Synchronous `getConfig()`, 30 s refresh, write-through on PATCH, env fallback, encrypted keys. Phase 1 extends it.
- `getOptionCatalog()` already decouples the UI from the taxonomy *shape*. Only the *source* changes.
- DeepSeek prompt-cache telemetry at [ai.ts:87](apps/api/src/services/ai.ts#L87) with the `[deepseek$]` prefix. This becomes the primary cost-regression signal for Phase 1.
- The human-pattern reply scheduler (seeded per-day PRNG, quiet windows, jitter) is the hardest-won logic in the repo. Parameterize it; never rewrite it.
- `sourcePostId` lineage, `publishedAt`, token-refresh health columns — landed and needed.

### What does not exist and blocks everything

**Zero tests.** No `*.test.ts`, no vitest/jest config, no `test` script. Survivable today because a human reviews every post. An autonomous system with no test suite will publish something broken at 2am and nobody will know until morning.

**Zero backups.** No `pg_dump` anywhere. Months of `StyleExample` and `PostInsight` — the entire learned voice — on one Supabase instance with no dump. Ranked #3 in [imp.md](imp.md), never shipped.

**No image generation.** [image-prompts.ts](apps/api/src/services/image-prompts.ts) writes *prompts*. Nothing turns a prompt into a file. The autonomy loop is impossible without it.

---

## Part II — The architecture

One idea carries the plan: **code holds mechanism, a `Profile` holds meaning.**

### The five config domains

```
Profile (one row today, N rows when tenancy arrives)
├── identity   who it is        → handle, display name, pronouns, age band, locale,
│                                 languages, niche, audience description
├── voice      how it writes    → tone traits, forbidden words, preferred slang, emoji
│                                 policy, casing, reply-length band, skip triggers
├── visual     what it looks like → subject descriptor block, style taxonomies
│                                 (outfit/locale/lighting/… as editable lists)
├── cadence    when it happens  → timezone, quiet windows, session bands, sleep config,
│                                 reply caps, posting-frequency targets
└── policy     what is forbidden → platform limits, hard blocks, AI labeling, autonomy
                                  levels per stage, budget ceilings
```

### Prompt composition replaces prompt constants

Every `SYSTEM_PROMPT` / `BRAND_VOICE` constant is deleted and replaced by a **composer**: a pure function. Templates carry mechanism ("you are writing a caption; here are the constraints; output JSON with keys X,Y"); the profile supplies every noun.

```ts
// services/prompt/compose.ts — pure, no I/O, fully unit-testable
export function composeSystemPrompt(p: Profile, task: TaskKind): string
```

**The prefix-cache constraint governs output ordering.** DeepSeek's prefix cache bills cached input at a fraction of miss price and is the largest recurring-cost lever here. The composer emits strictly in this order:

1. **Stable block** — everything derived from the profile. Byte-identical between profile edits.
2. **Semi-stable block** — few-shot `StyleExample` rows, ordered deterministically (by `createdAt`, never randomly sampled).
3. **Volatile block** — the comment text, the date, the specific post.

A profile edit legitimately busts the cache once. That is fine — but the UI must say so, and Phase 1 ships a snapshot test that fails when *code* (not config) alters a stable prefix.

### Config resolution: the fail-closed rule

[runtime-config.ts](apps/api/src/services/runtime-config.ts) returns `buildDefaults()` before the first DB load "so early-boot callers are safe." For numeric knobs that is right — a default cap is harmless.

**For profile data it is a live bug.** If persona becomes config and `getConfig()` fail-opens to a default, a worker tick during the ~200 ms boot window generates a reply in a *default voice* and publishes it. There is no undo on a published reply.

So the resolver splits:

```ts
getConfig(): ResolvedConfig    // numeric/operational — fail-OPEN to defaults (unchanged)
getProfile(): Profile | null   // identity/voice/visual — fail-CLOSED, null pre-load
```

Every AI call site does `const p = getProfile(); if (!p) return skip("profile not loaded")`. A skipped reply is recoverable; a wrong-voice published reply is not.

### Autonomy is a dial, not a switch

Full autonomy that cannot be partially disengaged is unshippable. Each stage gets an independent level stored in `policy`:

| Level | Meaning |
|---|---|
| `off` | stage does not run |
| `suggest` | produces output, parks it as a draft, notifies |
| `review` | produces + schedules, holds at a gate until approved (auto-expires to `off` after N hours) |
| `auto` | produces, schedules, publishes unattended |

Stages: `plan` → `generate_media` → `write_caption` → `schedule` → `publish` → `reply` → `learn`.

This makes the rollout safe *and* testable: ship every stage at `suggest`, watch a week, promote one stage at a time.

---

## Part III — The phases

Nine phases. Sequenced so each one is independently shippable and leaves the system working. Estimates assume solo part-time work.

| # | Phase | Effort | Gate to start | Status |
|---|---|---|---|---|
| 0 | Safety net | 4–6 d | — | 0.1 ✅ · 0.2 ✅ · 0.3 code done, needs R2 creds · 0.4 ⏸ needs accounts |
| 0.5 | Infra migration to Oracle Cloud | 2–3 d | Phase 0 green | ⏸ parked — needs both instances |
| 1 | Config core: identity + voice | 5–7 d | Phase 0.5 cut over | ✅ **done** |
| 2 | Visual config + taxonomy as data | 4–5 d | Phase 1 shipped | ✅ **done** |
| 3 | Cadence + policy as data | 4–5 d | Phase 1 shipped | ✅ **done** |
| 4 | Instagram engagement parity | 6–8 d | Phase 3 shipped | |
| 5 | Media generation pipeline | 6–8 d | Phase 2 shipped | |
| 6 | The autonomy loop | 8–10 d | Phases 4 + 5 shipped | |
| 7 | Autonomous hardening | 4–5 d | Phase 6 at `suggest` for 7 d | |
| 8 | Promotion to `auto` | 2 w elapsed | Phase 7 shipped | |

---

## Phase 0 — Safety net

**Why first:** you cannot build an autonomous system on top of an untested, unbacked one. Every later phase touches the code path that writes to a real account.

### 0.1 Test harness (2 d) — **DONE**

Vitest 5 at the workspace root ([vitest.config.mts](vitest.config.mts)), `pnpm test` / `pnpm test:watch`. **67 tests across 4 files, green.** Suites mock `@smm/db` and `runtime-config` themselves — nothing touches Postgres or Meta.

Mutation-verified as required below: breaking `IST_OFFSET_MIN` reddens 8 tests, widening the carousel bound reddens 2.

One source change was needed to make the validators reachable: `CreateBody` / `UpdateBody` in [posts.ts](apps/api/src/routes/posts.ts) are now exported. No behaviour change.

Target the pure logic first — it is where the bugs are and it needs no mocking:

| Test file | Covers | Why it matters |
|---|---|---|
| `reply-schedule.test.ts` | `dynamicWindowsForDay` determinism, quiet-window push, jitter bounds, day-boundary math | Same IST date must yield identical windows across processes. The API and worker each compute this independently — a mismatch means a reply fires inside a sleep window. |
| `caption-lint.test.ts` | bait detection, hook cutoffs, corporate-word list, non-application to replies | Already pure. Free coverage. |
| `posts.schema.test.ts` | per-platform caption caps, carousel bounds, chain rules, tag coords | Currently duplicated client + server. Test locks the server side, which is the one that actually protects the account. |
| `crypto.test.ts` | encrypt→decrypt round-trip, bad-key path returns null not garbage | `safeDecrypt` swallowing errors is load-bearing. |

**Verify:** `pnpm test` green, and deliberately break `IST_OFFSET_MIN` to confirm `reply-schedule.test.ts` goes red. A test suite that does not fail when you break the thing is not a test suite.

**Bug found while writing these — carried into Phase 3.3.** The hard blocks live in `CreateBody.superRefine`, and `UpdateBody` has no `superRefine` at all. So `PATCH /posts/:id` accepts a Threads caption over 500 chars and a 1-item `ig_carousel` — both guaranteed Meta rejections that reach the publish queue, where the 3-attempt retry burns on something that can never succeed. Editing a queued post is a normal path (it is what [imp.md](imp.md)'s round-trip fix was about), so this is reachable today. Three tests in `posts.schema.test.ts` document the current permissive behaviour and are marked to flip when Phase 3.3 lands.

### 0.2 Meta API contract fixtures (1.5 d) — **DONE**

[meta-stub.ts](apps/api/src/publishers/meta-stub.ts) intercepts both Graph hosts with MSW, records every call in order, and serves canned responses. [threads.contract.test.ts](apps/api/src/publishers/threads.contract.test.ts) (34) and [instagram.contract.test.ts](apps/api/src/publishers/instagram.contract.test.ts) (25) assert endpoint, per-post-type params, container-then-publish ordering, and error parsing.

Mutation-verified: breaking `share_to_feed`, the carousel `children` separator, and the IG `status_code` field each reddens the suite (4 failures total).

Contract details now pinned that were previously only implicit: IG image carousel children are *not* polled (only the parent is), `thumb_offset: 0` must survive a falsy check, Stories never carry a caption, and `location_id`/`collaborators` must stay off carousel children.

**Fixture caveat, restated because it matters:** these responses are derived from what the publishers parse, not recorded from live traffic. They pin *our* request contract and *our* parsing — they cannot catch Meta changing its schema. **Still outstanding:** the weekly live smoke test (`GET /me`, assert response *shape* against the fixture shape). It needs a live token, so it lands with 0.4.

### 0.3 Backups — encrypted `pg_dump` to Cloudflare R2 (1.5 d) — **CODE COMPLETE, VERIFICATION BLOCKED**

[db-backup.ts](apps/api/src/services/db-backup.ts) + [r2.ts](apps/api/src/services/r2.ts) + [admin.ts](apps/api/src/routes/admin.ts), wired into the engagement-worker tick (not `setInterval`). Self-throttled to one R2 check per 30 min, but always checking on the first tick after boot — which is what makes a restart pick up a missed day.

Three deviations from the original sketch, each deliberate:

- **Spool to a temp file, not a streamed multipart PUT.** The pipeline (`pg_dump | gzip | gpg`) never buffers in *memory*, which is the constraint that actually matters on a 1 GB box. Disk is the cheap resource (200 GB free), and a spooled file lets the upload send a known `Content-Length` instead of hand-rolling multipart signing.
- **No `@aws-sdk/client-s3`.** SigV4 path-style signing is ~60 lines of `node:crypto`; pulling a large dependency tree onto a small box to make four requests is not worth it. Requests use `x-amz-content-sha256: UNSIGNED-PAYLOAD`, which is what lets a large dump stream out of a file handle without being hashed into memory first.
- **`gpg` symmetric, not AES in Node.** A disaster-recovery artifact must not depend on the application that died. Restore is a standard one-liner on any machine with gpg:

```
gpg -d smm-20260909T120000Z.sql.gz.gpg | gunzip | psql "$DIRECT_URL"
```

`postgresql-client-17` comes from **PGDG, not Debian** ([Dockerfile](Dockerfile)): bookworm ships client 15, and `pg_dump` refuses to dump a server newer than itself — against a PG 16/17 Supabase instance the Debian client fails with a version mismatch. That only shows up in the deployed container.

**Tested (37 tests).** SigV4 determinism and sensitivity to method/key/query/date/secret, path-style URL and key encoding, canonical query ordering; `putFile` streaming with explicit `Content-Length`; list pagination via continuation token; error surfacing. Retention is pure and pinned hard in [db-backup.test.ts](apps/api/src/services/db-backup.test.ts) — daily quota, weekly quota, the Sunday/Monday week boundary, and "never delete the only backup" — because deleting the wrong object here is unrecoverable.

**Blocked on you:**
1. Create the R2 bucket + API token; set `BACKUP_R2_ENDPOINT`, `BACKUP_R2_BUCKET`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_PASSPHRASE`, `BACKUP_ENABLED=true`. **Store the passphrase somewhere that is not this database.**
2. `POST /admin/backup/run`, then `POST /admin/backup/restore-test`.
3. Then the real verification: corrupt a byte in the uploaded object and confirm the drill *fails*. A drill that cannot fail proves nothing.

Until step 3 passes this is untested code, not a backup.

### 0.4 A staging target (1 d) — **PARKED: waiting on credentials**

Blocked only on account creation, not on code. When the tokens exist:
- private IG Business + Threads accounts, added as testers on the Meta app
- `PROFILE_MODE=staging|production`, with the account read from the profile so staging is a config swap
- the weekly live shape-smoke test deferred from 0.2 lands here too (`GET /me`, assert the response *shape* against the fixture shape) — it needs a live token

### 0.4 A staging target (1 d)

Create a second, private IG Business account + Threads account. Add `PROFILE_MODE=staging|production`. Every destructive path (publish, reply) reads the account from the profile, so staging is a config swap, not a code branch.

**This is the single highest-leverage item in Phase 0.** Everything from Phase 5 onward needs somewhere to publish garbage safely.

**Risks in Phase 0**

| Risk | Mitigation |
|---|---|
| Adding Vitest bloats the deployed bundle | Vitest is a devDependency; esbuild bundle is unaffected. Verify bundle size before/after. |
| `pg_dump` binary missing from the image | Add `postgresql-client` to the Dockerfile. Verify in the deployed container, not locally. |
| Backup job memory (256 MB now, 1 GB after Phase 0.5) | Stream-only, never buffer. Eases after the migration but never stops mattering — dump size grows with the DB. |
| Staging IG account gets flagged as inauthentic | Use it at low volume; do not mirror the production persona wholesale. |

---

## Phase 0.5 — Infra migration to Oracle Cloud Always Free — **PARKED: waiting on both micro instances**

Blocked only on provisioning, not on code.

**Why here, not later:** every phase after this one gets built and tested on the machine it will actually run on. Doing Phases 1–4 on Fly and then migrating means re-validating all of it. And Phase 0 is what makes a host migration safe in the first place — you now have a test suite, a verified backup, and a staging account.

**What the target actually is.** `VM.Standard.E2.1.Micro` — **1 GB RAM, x86_64, 1/8 OCPU baseline (burstable)**, and Always Free gives you **two of them**, sharing 200 GB of block storage and 10 TB/month egress. Ampere A1 is explicitly not the target; capacity for it is unreliable and the micro is what actually provisions.

So the headline is **2 × 1 GB, not one big box**. That is 4× the current per-box memory — real relief, but not the removal of the constraint. Plan accordingly:

| What changes | What does not |
|---|---|
| Per-process memory ceiling goes 256 MB → ~1 GB | Memory is still a live constraint in Phase 5. Streaming stays load-bearing, not just good practice |
| x86_64 — same arch as today, no Prisma `binaryTargets` work, no ARM build pipeline | esbuild bundling ([Dockerfile](Dockerfile) step 4) stays worth keeping; the rationale shifts from "fits the tier" to "boots fast on 1/8 OCPU" |
| Two independent hosts, so processes can be isolated (below) | 200 GB block storage is shared *and* boot volumes consume it — two instances eat ~94 GB before you store a single image. Budget ~100 GB usable |
| The `ENGAGEMENT_ENABLED=false` memory escape hatch in [env.ts](apps/api/src/env.ts) becomes a role flag rather than a panic button | CPU is now the binding constraint, not RAM — see below |

**The 1/8 OCPU baseline is the thing to design around, not the gigabyte.** The micro shape is burstable: it sustains a fraction of a core and throttles under continuous load. Everything in this system is I/O-bound (polling, HTTP to Meta and DeepSeek, Postgres) which suits it well — but it means **image validation must not decode images**. Do not add `sharp`; read dimensions from file headers instead (a few hundred bytes), which is what Phase 5.2's validation actually needs. A `sharp` resize pipeline on 1/8 OCPU would be the first thing to fall over.

### The two-box split — the real win

Two free instances is better than one larger box for a system that publishes to an irreplaceable account, because it buys **fault isolation**:

```
Box A — "publisher"          Box B — "worker"
  Fastify API                  engagement worker (poll + reply)
  publish worker               media generation (Phase 5)
  token refresh                planner/executor (Phase 6)
  serves /media/*
  must never die               may OOM without consequence
```

`apps/web` is not deployed to either box — the [Dockerfile](Dockerfile) builds the API only, and the Next.js app is hosted separately. That is what makes 1 GB workable.

This directly retires the Phase 5 concern that a generation OOM takes down publishing, which is the reason [prod.ts](apps/api/src/prod.ts) currently runs everything in one process. Split it by role env flag, not by building two images.

### The work (2–3 d)

1. **Provision + harden two micro instances.** Two firewall layers must both be opened — the OCI security list *and* the instance's own iptables. Oracle images ship with restrictive local iptables rules; this is the single most common "the port is open but nothing connects" cause. Add swap (1–2 GB) on both boxes: with 1 GB RAM it is the difference between a slow moment and a killed process.

1b. **Introduce role flags before cutover.** `ROLE=publisher|worker` (or discrete `PUBLISHER_ENABLED` / `ENGAGEMENT_ENABLED` / `GENERATION_ENABLED`) read in [prod.ts](apps/api/src/prod.ts), so one image runs on both boxes with different responsibilities. This is the mechanism the whole two-box split depends on, and it is also the cutover safety device — see the double-publish risk below.
2. **TLS + public URL.** Meta must fetch media over public HTTPS ([storage.ts](apps/api/src/storage.ts) serves `/media/*`, and `PUBLIC_BASE_URL` feeds Meta's fetcher). Caddy with Let's Encrypt on a real domain. The Cloudflare Tunnel dev path stays as-is.
3. **Migrations run.** Fly's `release_command` in [fly.toml](fly.toml) currently runs Prisma migrations. Replace with an explicit deploy step — this is easy to forget and the failure mode is a schema/code mismatch in production.
4. **Keep Supabase.** Do not self-host Postgres to save nothing — it moves the backup burden onto you for zero gain. The DB stays where it is; only compute moves.
5. **Cut over.** Deploy to Oracle, verify against staging, flip `PUBLIC_BASE_URL` and DNS, keep Fly running in parallel for a month.

### Verification

- Full test suite green in the deployed container. Same arch as today, so this should be uneventful — confirm rather than investigate.
- Boot both boxes with their role flags and assert from the logs that **exactly one** runs the publish loop and **exactly one** runs the engagement loop.
- Watch memory on Box B for 24 h under normal engagement load before Phase 5 adds generation to it. Record the baseline — you need to know the headroom you are spending later.
- Publish a post to the staging account end-to-end from the Oracle box — this exercises the media-fetch path, which is the one thing that breaks silently if TLS or `PUBLIC_BASE_URL` is wrong. Meta fetches the URL itself, so a working browser check does not prove it works.
- Token refresh loop runs once successfully on the new host.
- Backup + restore drill from the new host.
- Leave both hosts running 48 h; confirm only one is publishing (see below).

### Where it breaks

| Failure | Mitigation |
|---|---|
| **Multiple hosts publish the same queued post** — the worker polls Postgres, so any two deployments against one DB double-post. Now a *permanent* risk, not just a cutover one: you are deliberately running two boxes | Role flags (1b) are the primary defence, and they must fail closed — an unset `ROLE` runs *nothing*, never everything. Back it with a DB-level advisory lock around the publish loop so two publishers cannot overlap even if misconfigured. Set `PUBLISHER_ENABLED=false` on Fly *before* starting Oracle; do not rely on remembering to stop a machine |
| Meta cannot fetch media (TLS chain, firewall, wrong `PUBLIC_BASE_URL`) | Publish to staging first. Test the URL from outside your network, not from the box. Note media is served from Box A — if you ever move `/media/*` to Box B, `PUBLIC_BASE_URL` must move with it |
| Instance reclaimed as idle → publishing silently stops | R6. External uptime check pinging `/health` from a third party, alerting to your phone. A host that dies quietly is worse than one that crashes. Applies to **both** boxes — Box B is the more likely victim, since an idle engagement worker is genuinely idle |
| 1 GB is tighter than it looks once Node + Prisma engine + the bundle are resident | Measure the baseline in verification above. Swap configured. Prisma's query engine is the largest single consumer — keep one client instance per process, never per-request |
| No `release_command` equivalent → migrations skipped | Explicit migrate step in the deploy script, run from Box A only, and a boot-time check that fails loudly on a pending migration |

---

## Phase 1 — Config core: identity + voice — **DONE**

The keystone phase. Everything after depends on it. See [docs/PROFILE.md](docs/PROFILE.md).

Shipped: `Profile` + `ProfileVersion` models and migration; zod types with placeholder validation; a pure composer; a fail-closed resolver; all 9 call sites migrated; `/profile` routes (get, patch, versions, rollback, preview); a Persona page in the web app.

**The migration's proof:** all five voice blocks and the subject descriptor compose **byte-for-byte** back to the constants they replaced. Mutation-verified twice — breaking `{{handle}}` substitution reddens 10 tests, and editing a prompt constant reddens the prefix-cache hash test *and only that test*.

Deviation from the sketch: the old constants were **not** deleted from `src/`. `seed.ts` imports them as the factory default rather than re-typing 200 lines of prompt into a fixture — while both forms exist there must be exactly one copy of the text. The database row is the source of truth once seeded, and seeding is idempotent so a redeploy cannot clobber an edited voice.

Also deferred deliberately: voice blocks stay as prose rather than being atomised into structured fields, because the prose already contains those rules and splitting them now would create two sources of truth for the same rule. Extraction has to remove the rule from the prose in the same commit.

### 1.1 Schema (0.5 d)

```prisma
model Profile {
  id            String   @id @default("default")
  name          String                       // internal label
  identityJson  Json                         // handle, pronouns, age band, locale, languages, niche, audience
  voiceJson     Json                         // tone traits, forbidden/preferred words, emoji policy, casing, length band
  visualJson    Json                         // Phase 2
  cadenceJson   Json                         // Phase 3
  policyJson    Json                         // Phase 3
  version       Int      @default(1)
  updatedAt     DateTime @updatedAt
}

model ProfileVersion {
  id         String   @id @default(cuid())
  profileId  String
  version    Int
  snapshot   Json                            // full profile at that version
  note       String?
  createdAt  DateTime @default(now())
  @@unique([profileId, version])
}
```

Versioning is not optional. Voice config is free text that feeds an LLM that writes to a real account — you *will* make an edit that degrades replies, and you need to see the diff and roll back.

**Migration:** seed the `default` row from the current constants verbatim, so behaviour before and after is byte-identical. This is the entire correctness story for Phase 1.

### 1.2 The composer (2 d)

`services/prompt/` — `compose.ts` (pure), `templates.ts` (mechanism only), `types.ts` (zod schemas for each JSON blob).

Zod-validate on write, not on read. A malformed profile must be rejected at PATCH time, never discovered by a worker mid-generation.

### 1.3 Call-site migration (1.5 d)

Replace the six constants. Order matters — migrate lowest-blast-radius first:

1. `dashboard-*.ts` (3 sites) — read-only analysis, wrong output is cosmetic
2. `ai.ts` caption paths — human reviews output before publish
3. `inspire.ts`, `image-prompts.ts` — human in the loop
4. `reply-generator.ts` — **last**, this one publishes unattended

### 1.4 Settings UI (1.5 d)

Extend [settings/page.tsx](apps/web/app/settings/page.tsx) with an Identity and a Voice section, matching the existing per-section save pattern from commit `4d13ea3`.

Two things the UI must do that a naive form would not:

- **Preview before save.** "Generate 3 sample replies with this voice against the last 3 real comments" — using the *draft* config, without persisting. Voice changes are unreviewable as raw JSON.
- **Warn on cache bust.** "Saving voice changes resets the prompt cache; the next ~10 AI calls cost more on input tokens." Honest, and it stops the user from tweaking 40 times a day.

### Verification

- **Byte-identity test:** `composeSystemPrompt(seededProfile, task)` output must exactly equal the old constant for every task. This is the migration's proof. Commit the old constants as test fixtures, then delete them from `src/`.
- **Snapshot/hash test:** hash each composed stable prefix. Fails on any change without an explicit `cache-bust ack` comment. This is the frozen-prompt CI test from [imp.md](imp.md), finally, and now it protects persona integrity as well as cost.
- **No-leak test:** grep the built bundle for the old handle. Zero hits outside test fixtures. `grep -ri "aisha" apps/api/dist/` must return nothing.
- **Live:** after deploy, watch `[deepseek$]` logs for 24 h. Hit rate should return to its pre-change baseline within ~10 calls per call site.

### Where it breaks

| Failure | Detection | Mitigation |
|---|---|---|
| Fail-open to a default persona during boot → wrong-voice reply published | Silent. Nobody notices. | The `getProfile(): Profile \| null` fail-closed split. Reply generator skips rather than guesses. Unit-test the null path explicitly. |
| Cache hit rate collapses because the composer interleaves volatile data into the prefix | `[deepseek$] ⚠️ LOW-CACHE` in logs | Composer emits stable→semi-stable→volatile. Assert ordering in a unit test, not just by reading the code. |
| Free-text voice config becomes a prompt-injection vector into its own system prompt | None today | The profile is user-authored and single-tenant, so this is low severity now — but strip control tokens and cap block length at write time so it stays low when tenancy lands. |
| `StyleExample` few-shots re-sampled randomly per call, busting the semi-stable block | Cache telemetry | Deterministic ordering, fixed N. Test that two consecutive composes are byte-identical. |
| A voice edit silently degrades reply quality | Nothing today | `ProfileVersion` + the preview panel + a weekly "replies skipped %" metric. A sharp rise in skips is the leading indicator of a broken voice config. |

---

## Phase 2 — Visual config + taxonomy as data — **DONE**

See [docs/VISUAL-STYLE.md](docs/VISUAL-STYLE.md). Shipped: the `StyleOption` model and migration; the eight hardcoded key unions extracted to `image-prompt-options.ts` as the factory default and seeded per-dimension; a cache with built-in fallback; the generator and catalog reading from it; CRUD routes with soft delete and restore-defaults; the tone-bias block moved into `profile.visual.toneBias`; a taxonomy editor on the Persona page that can add whole new axes.

`dimension` is a free string, so adding an axis is a data insert rather than a migration — the difference between configurable and merely parameterized.

**A trap found and fixed while doing it.** Adding `toneBias` with a zod `.default("")` would have silently switched the block off for the already-seeded profile row: parses fine, reads as empty, stops being emitted, no error anywhere. `backfillProfileDefaults()` fills fields added after seeding, keyed on the field being *absent* rather than empty so a deliberately cleared value is respected. Any future profile field needs the same treatment.

Mutation-verified on the two properties that keep old drafts working: resolving a removed key to a string instead of `null` reddens 2 tests, and accepting an empty table instead of keeping the built-ins reddens 1.

## Phase 2 (original plan) — Visual config + taxonomy as data

### 2.1 Taxonomy to the database (2 d)

```prisma
model StyleOption {
  id         String  @id @default(cuid())
  profileId  String
  dimension  String              // "outfit" | "locale" | "lighting" | "hairstyle" | …
  key        String              // stable slug
  label      String              // UI label
  promptText String              // the fragment injected into the image prompt
  enabled    Boolean @default(true)
  sortOrder  Int     @default(0)
  @@unique([profileId, dimension, key])
  @@index([profileId, dimension, enabled])
}
```

`dimension` is a free string, not an enum — adding a whole new axis ("prop", "mood", "season") must be a data insert, not a migration. That is the difference between configurable and merely parameterized.

The 9 unions in [image-prompts.ts](apps/api/src/services/image-prompts.ts) become the seed data for the `default` profile. `getOptionCatalog()` changes from returning constants to reading `StyleOption` — the UI contract does not change at all, which is why this phase is cheap.

### 2.2 Subject descriptor as config (1 d)

`BRAND_VOICE_VISUAL_FALLBACK` moves into `visualJson.subjectDescriptor`. The **PERSONA LOCK** mechanism at [ai.ts:456](apps/api/src/services/ai.ts#L456) — "reproduce the descriptor block verbatim, do not paraphrase, exact tokens lock identity across a set" — stays in the template. That instruction is mechanism (how image models keep a subject consistent); the descriptor itself is config.

### 2.3 Taxonomy editor UI (1.5 d)

CRUD per dimension, drag to reorder, enable/disable, and an "add dimension" affordance. Plus a **prompt preview** showing the fully assembled image prompt for a chosen combination — this is how you catch a `promptText` fragment that reads fine alone and contradicts another fragment when combined.

### Verification

- Seed-parity test: `getOptionCatalog()` from the DB deep-equals the old hardcoded catalog.
- Combinatorial smoke: generate prompts for 50 random valid combinations; assert none produce empty fragments, duplicated clauses, or a prompt exceeding the image model's token limit.
- Disable every option in one dimension → generation must degrade gracefully (omit that axis), not emit `undefined`.

### Where it breaks

| Failure | Mitigation |
|---|---|
| `undefined` leaks into a prompt when a key is deleted but still referenced by a saved draft | Soft-delete via `enabled=false`; never hard-delete a referenced option. Resolve unknown keys to omitted, never to the string "undefined". Test it. |
| Contradictory fragments ("indoor studio" + "golden hour sunset") | Optional `conflictsWith` array on `StyleOption`; UI greys out conflicting picks. Ship the field in Phase 2, populate lazily. |
| The subject descriptor drifts between images in one carousel | Already handled by PERSONA LOCK — but add a test asserting the descriptor appears verbatim at the head of every prompt in a set. |
| Prompt exceeds model token limit as options accumulate | Hard cap total assembled length; surface remaining budget live in the preview. |

---

## Phase 3 — Cadence + policy as data — **DONE**

See [docs/CADENCE.md](docs/CADENCE.md). Shipped: zone-aware time math replacing the fixed IST offset; cadence (timezone, quiet windows, session bands) in the profile; `@smm/shared` platform-rules table used by the API and the web app; the `UpdateBody` gap closed on both the schema and the merged-post path; the autonomy gate.

**The `UpdateBody` bug is fixed.** `PATCH /posts/:id` ran no hard blocks at all, so an edit could put a guaranteed Meta rejection into the publish queue. Both write paths now share one validator, and `updatePost` re-validates the merged post because the route schema can only see the patch — a PATCH omitting `scheduledAt` on an already-queued post would otherwise read as a draft and skip the minimums.

**A draft/publish distinction was needed and is new.** Enforcing minimums at create time would have blocked saving an incomplete post — the old code only did this for carousels, inconsistently. Minimums now apply at publish; maximums, caption caps and type/platform mismatches apply always.

**Mutation-verified, and the first attempt was vacuous.** A DST test that only pushed off *static* quiet windows passed against both the old and new math, because the static windows were already resolved through the timezone. The replacement observes a dynamic sleep window directly and does fail against the old `local midnight + N minutes` math.

Deviation: sleep counts and durations stay in `AppSettings` rather than moving into cadence. They are weekly tuning knobs with a working Settings UI; moving them would have meant rewriting that page for no gain. Documented in CADENCE.md.

## Phase 3 (original plan) — Cadence + policy as data

### 3.1 Timezone (1.5 d) — the sharp edge

`IST_OFFSET_MIN` becomes `profile.cadence.timezone` (IANA, e.g. `Asia/Kolkata`). All math moves to `Intl.DateTimeFormat` with that zone.

**This introduces DST, which the current code explicitly assumes away** (`// IST is UTC+5:30 fixed (no DST)`). Real bugs this creates:

- A DST-spring day has 23 hours. `dynamicWindowsForDay` splits a session into N+1 random segments over a fixed length — on a short day, windows can be computed past the session end and a reply fires in what should be a sleep window.
- A DST-fall day has 25 hours and a repeated local hour. The PRNG day-key derived from a local date is now ambiguous, and quiet windows can double-apply.
- `Date.UTC(y,m,d,hour) - OFFSET` at [reply-schedule.ts:51](apps/api/src/services/reply-schedule.ts#L51) is only valid for fixed-offset zones.

**Mitigation:** compute all window boundaries as *absolute UTC instants* via the zone's actual offset for that specific date, never by subtracting a constant. Then unit-test explicitly against `America/New_York` across both 2026 transition dates, asserting: no window extends past session end, no instant is scheduled twice, total sleep minutes stay within tolerance. Keep `Asia/Kolkata` as the default so the current deployment is unaffected either way.

### 3.2 Windows, bands, caps (1 d)

`QUIET_WINDOWS_IST`, `MORNING_BAND`, `EVENING_BAND` become arrays in `cadenceJson`. Delete the duplicated validation constants in [settings.ts:7-10](apps/api/src/routes/settings.ts#L7) — validation reads the same config the scheduler does.

Validation rules that must survive: sleeps must fit inside their band with `MIN_ACTIVE` between each; windows must not overlap; total quiet + sleep must leave a non-empty active period. Currently enforced in [settings.ts:48](apps/api/src/routes/settings.ts#L48); move to a shared pure validator used by both the route and the scheduler.

### 3.3 Platform policy as one table (1.5 d)

A single `platform-rules.ts` in a shared workspace package, imported by both API and web. Caption caps, media counts, mime rules, first-line cutoffs, aspect ratios, rate-limit budgets — one source of truth, currently three.

**This is where the `UpdateBody` gap found in Phase 0.1 gets closed.** One validator, applied on both create *and* edit — the bug exists precisely because the rules were inlined into one zod schema instead of living in a shared table. Flip the three documenting tests in `posts.schema.test.ts` when it lands.

The *values* are platform facts (2200 chars is Meta's rule, not a preference) so they live in code. The *creator preferences* layered on top (preferred caption length, emoji policy, bait-phrase list) live in `policyJson`.

This distinction matters: making Meta's hard limits "configurable" would let a user configure their way into a guaranteed API rejection.

### 3.4 Autonomy levels (1 d)

Add the `policyJson.autonomy` map (stage → level) and a `services/autonomy.ts` gate: `can(stage): Level`. Every stage entry point calls it. Ships in Phase 3 defaulting every stage to today's effective behaviour (`publish: auto`, `reply: auto`, everything else `off`), so nothing changes yet — the gate is in place before there is anything to gate.

### Verification

- DST test matrix as above.
- Determinism-across-processes test: given a fixed profile + date, API and worker compute identical windows. Run the same function twice in separate Node processes and diff.
- Config-change safety: edit sleep config mid-day → today's already-frozen windows must not reshuffle (the current code freezes per day; keep that property under test).

### Where it breaks

| Failure | Mitigation |
|---|---|
| Timezone change mid-day reshuffles windows; queued replies fire at wrong local times | On timezone change, freeze the current day and apply from next local midnight. Show this in the UI. |
| Invalid cadence saved via API bypassing UI validation | Zod + the shared validator at the route; reject with the specific reason (the current error messages at [settings.ts:92](apps/api/src/routes/settings.ts#L92) are a good model — keep that quality). |
| Worker and API disagree after a config edit (30 s cache skew) | Already handled by write-through + 30 s refresh. Add a `configVersion` int to the log line on every scheduled reply so skew is diagnosable after the fact. |
| Removing all quiet windows → bot-like 24/7 replying → account action-block | Hard floor in the validator: minimum total quiet hours per day (e.g. 6). This is a safety rail, not a preference. |

---

## Phase 4 — Instagram engagement parity

Today auto-reply is Threads-only. "Ready for both platforms" requires this.

### 4.1 Platform-agnostic engagement service (2.5 d)

Extract an interface both publishers satisfy:

```ts
interface EngagementAdapter {
  listRecentPosts(account, opts): Promise<PlatformPost[]>
  listComments(postId, account): Promise<PlatformComment[]>
  replyToComment(commentId, text, account): Promise<{ id: string }>
  capabilities: {
    supportsPrivateReply: boolean      // IG only
    supportsTopicTags: boolean         // Threads only
    commentablePostTypes: PostType[]   // IG Stories have no comments
  }
}
```

Rewrite [engagement.ts](apps/api/src/services/engagement.ts) to loop over enabled accounts and dispatch through the adapter. Remove all 7 hardcoded `platform: "threads"` literals plus the 2 `where` filters.

### 4.2 Instagram comment adapter (2 d)

`GET /{ig-media-id}/comments` for ingestion, `POST /{ig-comment-id}/replies` for replies. Requires the `instagram_manage_comments` permission — **verify this is granted on the existing token before building the adapter**, not after. If it is missing, re-auth is required and that is a schedule risk worth knowing on day one.

Platform differences that are real work, not config:

- IG Stories accept no comments → must be excluded from polling or every tick wastes read budget on 400s.
- IG threading is one level deep (replies to replies attach to the parent). The "reply at most once per conversation tree" rule needs different traversal than Threads.
- IG *private replies* (DM in response to a comment, one per comment, 7-day window) are an IG-only capability. Model it, gate it behind its own autonomy stage, ship it disabled.
- IG rate limits are per-app-per-user and differ from Threads. The existing [rate-limiter.ts](apps/api/src/services/rate-limiter.ts) budget must be split per platform, not shared — otherwise IG polling starves the Threads budget that currently works.

### 4.3 Webhooks (2 d)

Finish [webhooks.ts](apps/api/src/routes/webhooks.ts): verify `X-Hub-Signature-256` against `META_APP_SECRET` using `@fastify/raw-body` **scoped to `/webhooks/meta` only** (global raw-body breaks every other route's JSON parsing — a real, easy-to-hit bug). Parse `entry[].changes[].value`, dedupe on `platformCommentId` (the `@unique` constraint already backs this), insert via `planReplyTime()`.

Subscribe separately to Threads replies/mentions and IG comments — different subscription fields.

**Keep the 8-minute poller as a safety net.** Fly machines with `auto_stop_machines = "off"` should stay warm, but webhook delivery to a single-machine deployment is not guaranteed. The hot-post 60 s burst (already shipped) plus webhooks plus a slow poller is belt-and-braces, and the read budget can afford it.

### Verification

- Adapter conformance suite: one test file run against both adapters, asserting identical semantics for ingest → dedupe → reply → mark-replied.
- Signature test: valid signature accepted, tampered body rejected 403, missing header rejected. Use a recorded real payload.
- Replay test: post the same webhook payload 3× → exactly one `EngagementComment` row.
- Staging: comment on a staging IG post from a second account, assert full round-trip.

### Where it breaks

| Failure | Mitigation |
|---|---|
| Global raw-body parser breaks all JSON routes | Scope to the webhook route. Add a smoke test hitting `PATCH /settings` with JSON after registering webhooks. |
| Webhook + poller both ingest the same comment → double reply | `platformCommentId @unique` + insert-ignore. Test the race explicitly with concurrent inserts. |
| IG read budget starves Threads polling | Per-platform budgets in `rate-limiter.ts`. Alert when either exceeds 80%. |
| Missing `instagram_manage_comments` discovered late | Verify on day 1 with a one-off curl. Blocking prerequisite. |
| Replying to a comment on a post published before the system existed → no `postId`, no caption context | `postId` is already nullable. Generator must handle null `postCaption` — test that path. |
| IG action-block from reply volume | The existing human-pattern scheduler applies to IG too once it is platform-agnostic. Do not give IG its own looser schedule. |

---

## Phase 5 — Media generation pipeline

The missing half of Stage 3. Prompts exist; images do not.

### 5.1 Provider interface (1 d)

```ts
interface ImageProvider {
  generate(prompt: string, opts: { count, aspect, seed? }): Promise<GeneratedImage[]>
  readonly id: string
  readonly costPerImage: number
}
```

Provider choice, model id, and API key live in `AppSettings` alongside the existing DeepSeek/OpenRouter fields, with the same encrypted-at-rest treatment. "Nothing hardcoded" includes the image model.

**Honest cost note:** with hosting on Oracle Always Free and the DB on Supabase free tier, image generation becomes the *only* recurring cost in the system. It has no free tier at usable quality. Budget roughly $0.003–$0.03/image depending on provider and model; at 2 posts/day with 3 candidates each that is a few dollars a month. Phase 7's budget ceiling makes it bounded rather than open-ended.

**Self-hosting the image model is not an option here.** A 1 GB micro instance cannot even load an SDXL or Flux checkpoint, let alone run inference on a fraction of a core with no GPU. Not a trade-off to weigh — it simply does not fit. Use a hosted provider, and make it swappable (5.1) so a cheaper one can be dropped in later.

### 5.2 Asset pipeline (2.5 d)

Generate → validate → store → register as `MediaAsset`. Validation before storage: dimensions and aspect ratio against the target post type, file size against Meta limits, mime type. A generated image that fails IG's aspect requirements must be caught here, not at publish time when it burns a retry.

Stream provider → disk → storage driver. Never `Buffer.concat` a set of images. On a 1 GB box this is still a survival constraint, not a style preference — streaming is what makes a 10-image carousel cost the same peak memory as a single image.

**Validate from file headers, not by decoding.** Dimensions, mime, and size all come from the first few hundred bytes of a JPEG/PNG/MP4. Do not add `sharp` — a decode-and-resize pipeline is the one workload that would break the 1/8 OCPU baseline (R6c), and Phase 5 needs none of it.

### 5.3 AI-content labeling (0.5 d) — non-negotiable

`Post.aiGenerated` already exists but per the README the user is merely *reminded* to toggle "AI Info" in the IG app. For autonomous publishing of generated media that is not sufficient — Meta requires AI-generated imagery to be disclosed, and undisclosed AI content is exactly the kind of thing that gets an account actioned.

Set the platform's AI-content flag on the publish call for any post whose assets came from a generator. If the API field is unavailable for a post type, that post type must be blocked from `auto` publishing with generated media and held at `review` with an explicit "label this manually" prompt. Encode it as a policy rule, not a habit.

### 5.4 Candidate + selection flow (2 d)

Generate N candidates, present them, record the choice. The choice is training signal: which prompt combinations the user actually picks is the only feedback loop that can improve generation over time. Store `selectedCandidateId` + the full option combination that produced it.

### Verification

- Provider contract test against a recorded fixture; a live test behind an env flag so CI does not spend money.
- Validation matrix: known-bad images (wrong aspect, oversized, wrong mime) must all be rejected pre-storage.
- Memory: generate a 10-image carousel on Box B with memory watched, compared against the baseline recorded in Phase 0.5. This is still the most likely thing to OOM — the difference from before is that when it does, Box A keeps publishing.
- Labeling: publish a generated post to staging, then verify via the API read-back that the AI flag is actually set on the platform. Do not trust the write call's 200.

### Where it breaks

| Failure | Mitigation |
|---|---|
| OOM during generation on the 1 GB box | Isolated to Box B by the Phase 0.5 role split, so the publisher survives. Stream everything, concurrency 1, header-only validation, swap on. A failed generation must park the post as `draft`, never leave it half-created. |
| Provider returns NSFW-flagged or refused output mid-loop | Provider errors are normal, not exceptional. Retry once with the same prompt, then park the post as `draft` with the reason. Never publish a placeholder. |
| Generated subject drifts from the descriptor | Seed pinning + PERSONA LOCK + a human spot-check gate that stays at `review` longer than other stages. |
| Cost runaway from a retry loop | Per-day image budget in `policyJson`, checked before every call, hard-stop with a notification. Phase 7. |
| Storage fills the block volume | Retention: delete unselected candidates after 7 days, alert at 80%. Budget against ~100 GB usable, not 200 — two boot volumes consume roughly half the free allowance. |
| Undisclosed AI content → account action | 5.3, enforced as a publish-time policy check that can block, not a UI reminder. |

---

## Phase 6 — The autonomy loop

Only now is this safe to build.

### 6.1 The planner (3 d)

`services/planner.ts` — given the profile, the content calendar, recent performance from `PostInsight`, and cadence targets, produce a plan: what to post, which type, when, on which platform.

Inputs that already exist and should be used: `bestTimes` (already backing the peak chips), `dashboard-engagement-mix`, `PostInsight` velocity, `AccountSnapshot` follower trend, and `sourcePostId` lineage for cross-posting decisions.

Output is a `ContentPlan` row of proposed slots — not posts. Nothing is created until the next stage runs.

```prisma
model ContentPlan {
  id         String   @id @default(cuid())
  profileId  String
  forDate    DateTime
  slotsJson  Json      // [{ platform, type, targetTime, theme, rationale }]
  status     String    // proposed | accepted | executed | expired
  createdAt  DateTime  @default(now())
}
```

### 6.2 The executor (3 d)

Walks a plan slot through: `generate_media` → `write_caption` → `schedule`. Each step checks `autonomy.can(stage)` and either proceeds, parks as draft, or waits at a review gate.

Idempotency is the whole game. Every step writes its output before advancing, and re-entry resumes rather than restarts. A worker restart mid-slot must not produce two posts. Key on `(planId, slotIndex)` with a unique constraint.

### 6.3 Review gates (1.5 d)

A queue view of everything waiting on approval, with one-click approve/edit/reject and an expiry. **A gate that never expires becomes a silent stall** — an unattended review gate must auto-downgrade to `off` and notify, not sit forever.

### 6.4 The learning loop (1.5 d)

Extend the existing `style-learning.ts` pattern: feed published-post performance back into planner weighting. Deliberately conservative — weight *slot and format selection*, not voice. Voice learning already exists via `StyleExample` and is human-curated; keep it that way.

### Verification

- Full dry run: staging profile, autonomy all at `suggest`, run 7 days. Every artifact produced but nothing published. Review each morning.
- Idempotency: kill the worker mid-slot at each step boundary; assert exactly one post exists after restart.
- Determinism: same plan + same seed → same slot decisions.
- Cost: measure actual spend over the 7-day dry run before promoting anything to `auto`.

### Where it breaks

| Failure | Mitigation |
|---|---|
| Duplicate posts from worker restart | Unique `(planId, slotIndex)`; write-then-advance; test with induced crashes. |
| Planner proposes a slot in a quiet window | Planner must consume the same cadence validator as the scheduler. Shared pure function, tested once. |
| Review gate stalls; nothing posts for days | Expiry + notification. Also a "days since last publish" health metric on the dashboard. |
| Feedback loop collapses to one format (local maximum) | Enforce a minimum exploration rate — a fixed fraction of slots ignore the weighting. |
| Plan generated against a stale profile mid-edit | Snapshot `profile.version` into the plan; refuse to execute a plan whose profile version has changed, re-plan instead. |
| LLM writes an off-brand caption at `auto` | Caption passes the existing `caption-lint` + hard blocks before scheduling. Lint failure → downgrade that item to `review`, do not publish. |

---

## Phase 7 — Autonomous hardening

### 7.1 Circuit breakers (1.5 d)

Automatic halt on: N consecutive publish failures, N consecutive AI errors, token refresh failing, daily budget exceeded, or an anomalous engagement drop (possible action-block). Halt means "stop and notify", never "retry harder".

### 7.2 Budget ceilings (1 d)

Per-day and per-month caps for LLM tokens and image generations, checked before each call. Surface spend-to-date in the UI. The existing `[deepseek$]` telemetry gives token counts already; add cost math and image counts.

### 7.3 Observability (1.5 d)

A single "is it healthy" view: last publish, last reply, queue depths, token expiry, cache hit rate, spend, circuit-breaker state, last backup. One page that answers "is the autonomous system actually working" without reading logs.

### 7.4 Kill switch depth (1 d)

`killSwitch` exists and is checked. Audit that it is checked in *every* new path from Phases 5–6 — generation, planning, execution — not just publish and reply. Add a test that asserts each entry point respects it.

---

## Phase 8 — Promotion to `auto`

Not a coding phase. A schedule.

| Week | Action | Rollback trigger |
|---|---|---|
| 1 | `write_caption` → `auto`, everything else `review` | any caption needing edit at the gate |
| 2 | `schedule` → `auto` | any slot placed wrongly |
| 3 | `generate_media` → `auto`, publish still `review` | any unusable image |
| 4 | `publish` → `auto` on **one** platform | any failed or off-brand publish |
| 5 | `publish` → `auto` on both | engagement anomaly |
| 6 | `plan` → `auto` | plan quality drop |

`reply` is already effectively `auto` today and stays there.

One rule: **only one stage is promoted at a time, and a rollback resets the clock.** The point is attribution — if quality drops after two simultaneous promotions you cannot tell which caused it.

---

## Part IV — Testing strategy

| Layer | Tool | What | When |
|---|---|---|---|
| Unit | Vitest | pure logic: scheduling math, composition, lint, validation | every commit |
| Snapshot | Vitest | composed prompt prefixes hashed; fails without `cache-bust ack` | every commit |
| Contract | MSW + fixtures | Meta API request shapes, error parsing | every commit |
| Conformance | Vitest | one suite run against both platform adapters | every commit |
| Integration | Vitest + test DB | full pipeline against a fake Meta | pre-deploy |
| Restore drill | script | backup → restore → row-count assert | weekly |
| Live smoke | script | `GET /me` shape vs fixture; publish to staging | daily |
| Dry run | manual | 7 days at `suggest`, human review each morning | before each `auto` promotion |

**The two tests that matter most**, because they catch the failures nobody would otherwise notice:

1. **Prompt-prefix hash test** — catches both silent cost regressions and accidental persona corruption in one assertion.
2. **Scheduler determinism across processes** — the API and the worker each compute reply windows independently. If they ever disagree, replies fire inside sleep windows and the human-pattern defense protecting the account quietly stops working, with no error anywhere.

---

## Part V — Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Account action-block from autonomous behaviour | Medium | **Severe** — the account is irreplaceable | Human-pattern scheduler applies to both platforms; minimum-quiet-hours floor; engagement-anomaly circuit breaker; staged promotion; staging account first |
| R2 | Undisclosed AI media violates platform policy | Medium | Severe | Publish-time labeling enforced as a policy check (5.3); block `auto` for post types that cannot be labeled via API |
| R3 | Wrong-voice content published during config load | Medium | High | Fail-closed `getProfile()`; skip beats guess; explicit null-path test |
| R4 | Prompt-cache collapse multiplies AI spend | Medium | Medium | Composer ordering + hash test + `[deepseek$]` monitoring + budget ceiling |
| R5 | Data loss (voice + insights, no backups) | Low | **Severe** — unrecoverable | Phase 0.3, with a verified restore drill |
| R6 | Oracle reclaims an Always Free instance as idle | Medium | High — silent loss of the publisher or the worker | Always Free compute can be reclaimed when CPU/network/memory all sit low for 7 days. A Postgres-polling worker is exactly that profile, and Box B is the likelier victim. External `/health` check on **both** boxes alerting to your phone; hold the Fly deployment as a warm fallback for one month after cutover |
| R6b | Memory pressure on a 1 GB box once generation lands | Medium | Medium | Generation is isolated to Box B, so the blast radius is a failed post, not a dead publisher. Stream everything, concurrency 1, header-only image validation (no `sharp`), swap configured, baseline measured before Phase 5 |
| R6c | Sustained CPU work throttled by the 1/8 OCPU baseline | Medium | Low | The workload is I/O-bound and suits burstable CPU. The one thing that would break this is image decoding/resizing — explicitly excluded in Phase 5.2 |
| R7 | DST bugs after timezone becomes configurable | Medium | Medium | Absolute-instant math; explicit DST test matrix; `Asia/Kolkata` stays default |
| R8 | Duplicate publishes — from worker restarts, or from two boxes both running the publish loop | Medium | High | Idempotency keys + induced-crash tests; fail-closed role flags (unset `ROLE` runs nothing); DB advisory lock around the publish loop. The two-box split makes this a standing risk rather than a one-off cutover risk |
| R9 | Meta API changes break publishers | Medium | High | Contract fixtures + daily live shape smoke test |
| R10 | Cost runaway from retry loops | Medium | Medium | Budget ceilings checked pre-call; circuit breakers |
| R11 | Feedback loop degenerates to one format | Medium | Low | Enforced exploration rate |
| R12 | Config UI edits produce unreviewable voice drift | **High** | Medium | `ProfileVersion` + diff + preview panel + skip-rate metric as leading indicator |
| R13 | `instagram_manage_comments` not granted | Medium | Medium (schedule) | Verify day 1 of Phase 4 with a curl, before any adapter work |
| R14 | Two sources of truth for platform limits drift apart | High | Low | Shared `platform-rules.ts`; delete the duplicates in the same commit |

---

## Part VI — Sequencing

```
Phase 0    Safety net            ████                                    4-6 d
Phase 0.5  Oracle migration          ██                                  2-3 d
Phase 1    Identity + voice            ██████                            5-7 d
Phase 2    Visual + taxonomy                 ████                        4-5 d   ┐ parallel
Phase 3    Cadence + policy                  ████                        4-5 d   ┘
Phase 4    IG engagement parity                  ██████                  6-8 d   ┐ parallel
Phase 5    Media generation                      ██████                  6-8 d   ┘
Phase 6    Autonomy loop                              ████████          8-10 d
Phase 7    Hardening                                          ████        4-5 d
Phase 8    Promotion to auto                                    ██████   6 w elapsed
```

Roughly **8–10 weeks of build**, then 6 weeks of staged promotion running in parallel with normal use.

Phases 2 and 3 are independent of each other; so are 4 and 5. Everything depends on Phase 1, Phase 1 depends on Phase 0.5, and 0.5 depends on Phase 0.

Phase 0.5 could technically slip — nothing before Phase 5 strictly needs the extra memory. But every week it slips is a week of work validated on a host you are leaving, and the role-flag split it introduces is a prerequisite for Phase 5's fault isolation.

### If the timeline has to compress

Drop, in this order: Phase 5's candidate-selection UI (generate 1, not N) → Phase 6's learning loop (weight by hand) → Phase 4's IG private replies.

**Never drop:** Phase 0 in any part, the fail-closed profile resolver, AI-content labeling, or staged promotion. Those four are what stand between an autonomous system and a lost account.

### Start here

1. Vitest + the four pure-logic test files (Phase 0.1) — one day, and it makes everything after it verifiable.
2. The staging account (Phase 0.4) — one day, unblocks all destructive testing.
3. Backups (Phase 0.3) — the only currently-unrecoverable risk in the system.
4. `curl` the IG token for `instagram_manage_comments` — five minutes, and it de-risks Phase 4 eight weeks early.
5. **Provision both micro instances during Phase 0.** They reliably provision, so this is not a gating risk — but having them live early means Phase 0's backup and restore drill runs against the host you are actually keeping.
