# Testing

The suite exists because the system is moving toward autonomous operation. While a human reviews every post, a bug costs an awkward caption. Once the planner and publisher run unattended, the same bug publishes to a real, irreplaceable account at 2am and nobody finds out until morning.

```
pnpm test          # one run
pnpm test:watch    # watch mode
```

Config lives in [vitest.config.mts](../vitest.config.mts). Everything runs in a `node` environment against `apps/**/*.test.ts` and `packages/**/*.test.ts`. **No test touches Postgres, Meta, R2, or DeepSeek** — suites that import a module with those dependencies stub them.

**321 tests across 15 files.**

## What is covered

| Suite | Tests | What it pins |
|---|---|---|
| [reply-schedule.test.ts](../apps/api/src/services/reply-schedule.test.ts) | 25 | local date/day-boundary math, per-day sleep-window determinism, session invariants, quiet-window pushes, `planReplyTime` properties, DST zones |
| [posts.schema.test.ts](../apps/api/src/routes/posts.schema.test.ts) | 34 | caption caps per platform, carousel bounds, reply-chain rules, user-tag coords, `scheduledAt` |
| [caption-lint.test.ts](../apps/web/lib/caption-lint.test.ts) | 19 | corporate/bait/emoji-clump detection, hook cutoffs per post type |
| [crypto.test.ts](../apps/api/src/crypto.test.ts) | 6 | AES-GCM round-trip, random IV, tamper detection |
| [threads.contract.test.ts](../apps/api/src/publishers/threads.contract.test.ts) | 34 | Threads request shapes, container→publish ordering, topic-tag sanitizing, error parsing |
| [instagram.contract.test.ts](../apps/api/src/publishers/instagram.contract.test.ts) | 25 | IG request shapes per post type, carousel child handling, container extras, error parsing |
| [r2.test.ts](../apps/api/src/services/r2.test.ts) | 18 | SigV4 signing, path-style URLs, list pagination, streamed upload |
| [db-backup.test.ts](../apps/api/src/services/db-backup.test.ts) | 15 | backup scheduling predicate, key format, retention policy |
| [tz.test.ts](../apps/api/src/services/tz.test.ts) | 26 | zone offsets, wall-clock resolution, both DST transitions |
| [compose.test.ts](../apps/api/src/services/prompt/compose.test.ts) | 29 | byte-identity with the replaced constants, placeholders, prefix-cache hash |
| [resolver.test.ts](../apps/api/src/services/profile/resolver.test.ts) | 13 | the fail-closed profile rule, seeding idempotence |
| [platform-rules.test.ts](../packages/shared/src/platform-rules.test.ts) | 31 | caption caps, media bounds, draft vs publish, mime rules |
| [autonomy.test.ts](../apps/api/src/services/autonomy.test.ts) | 18 | per-stage levels, defaults, level-to-behaviour mapping |
| [style-options.test.ts](../apps/api/src/services/style-options.test.ts) | 18 | taxonomy fallback, soft deletes, null resolution, custom dimensions |
| [image-prompts.test.ts](../apps/api/src/services/image-prompts.test.ts) | 6 | the option catalog the composer renders |

## The two tests that matter most

Most of the suite is ordinary regression cover. These two catch failures that would otherwise be **completely silent**:

**1. Scheduler determinism across processes** — `reply-schedule.test.ts > is identical in a freshly loaded module`. The API process and the worker process each compute the day's sleep windows independently from a seeded PRNG. If they ever disagree, replies fire inside what the other believes is a sleep window, the human-pattern defence protecting the account quietly stops working, and **nothing logs an error**. The test clears the module registry and re-imports to approximate a second process.

**2. Prompt-prefix hashing** — `compose.test.ts > prefix stability > has a stable hash across the whole seed profile`. The composed system prompts are the entire cached DeepSeek prefix, and that discount is the largest recurring cost lever here. A code change that alters the output silently multiplies the bill. Verified: editing one character in a prompt constant reddens this test **and only this test**.

## How to trust a test

A test that cannot fail proves nothing. Every suite here has been mutation-checked: break the thing, confirm red, revert.

| Mutation | Result |
|---|---|
| `IST_OFFSET_MIN` 5:30 → 5:00 | 8 failures |
| carousel bound `n < 2 \|\| n > 10` → `n < 2` | 2 failures |
| IG `share_to_feed` always `"true"` | 1 failure |
| Threads carousel `children` joined with `;` | 1 failure |
| IG container poll field `status_code` → `status` | 2 failures |
| `{{handle}}` substitution returns `""` | 10 failures |
| one character changed in a prompt constant | 1 failure (the cache-bust hash, and only it) |
| dynamic sleep windows via `local midnight + N minutes` | 1 failure (the DST test) |
| carousel upper bound removed from the shared table | 3 failures |
| removed style key resolves to a string instead of `null` | 2 failures |
| empty style table accepted instead of keeping the built-ins | 1 failure |

When you add a suite, do this once before trusting it. It is how the `fetchPostInsights` metric test was caught passing for the wrong reason — the stub was JSON-serializing a `Response` object instead of failing the request, so the `try`/`catch` under test never ran.

## Stubbing patterns

**Meta APIs** — [meta-stub.ts](../apps/api/src/publishers/meta-stub.ts) intercepts both Graph hosts with MSW, records every call in order, and serves canned responses. Assert on `stub.paths()` for ordering and `stub.params(n)` for request shape.

```ts
const { stub, server } = metaServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); stub.reset(); });
```

**Prisma / runtime config** — mock at the module boundary. `reply-schedule.test.ts` mocks both so the scheduling math is tested against a config spelled out in the test file, rather than whatever the defaults happen to be.

```ts
vi.mock("@smm/db", () => ({ prisma: { engagementComment: { count: vi.fn(async () => 0) } } }));
vi.mock("./runtime-config.js", () => ({ getConfig: () => TEST_CONFIG }));
```

## Known limitation: fixtures are not recordings

The Meta contract fixtures are **derived from what the publishers parse, not captured from live traffic**. They pin our request contract and our parsing. They cannot catch Meta changing its response schema — if Meta renames a field tomorrow, these tests stay green and production breaks.

The mitigation is a weekly live shape-smoke test (`GET /me`, assert the response *shape* against the fixture shape). It needs a live token, so it lands with the staging account in Phase 0.4. **Until then, this is an uncovered gap, not a solved problem.**

## Documented gaps

*The `UpdateBody` gap recorded here was closed in Phase 3.3 — see [CADENCE.md](./CADENCE.md#the-bug-this-closed). Those tests now assert enforcement.*

The pattern is worth keeping: documenting a gap as a **passing** test beats leaving a red test in the suite. A red suite gets ignored within a week, and then it stops catching anything.

## A test can pass for the wrong reason

Two examples from this suite, both caught by mutation-checking rather than by review:

- An Instagram insights test returned a plain `Response` from the stub, which got JSON-serialised into a 200 instead of failing the request — so the `try`/`catch` it claimed to exercise never ran.
- A DST test asserted that replies never land in a quiet window on a transition day. It passed against the *old, broken* offset math too, because it only exercised the **static** windows, which were already resolved through the timezone. The replacement observes a **dynamic** sleep window directly and does fail against the old math.

Both looked reasonable. Neither tested what its name said. Mutation-checking is the only thing that found them.
