# The Profile

Everything about *who* this account is — handle, voice, look — lives in one database row, not in the code. The prompt builders carry mechanism only; every noun they use comes from here.

Edit it at **`/profile`** (Persona in the sidebar). Nothing needs a redeploy.

## Why

Six prompt constants used to name one specific handle, age, nationality, niche and audience — the caption voice, the reply agent, and three dashboard analysts. Changing any of them meant editing TypeScript and shipping. Anyone else running this system would have inherited a persona that had nothing to do with them.

## Shape

| Domain | Holds | Status |
|---|---|---|
| `identity` | handle, display name, pronouns, age band, nationality, locale, languages, niche, audience | live |
| `voice` | the five system prompts, as prose with `{{placeholders}}` | live |
| `visual` | subject descriptor for image generation | live |
| `cadence` | timezone, quiet windows, session bands | **stub** — Phase 3 |
| `policy` | autonomy level per stage, budget ceilings | **stub** — Phase 3 |

The last two columns exist so the schema is settled, but nothing reads them yet. `cadence.timezone` records `Asia/Kolkata`; the scheduler still uses its own constant until Phase 3.

## Voice is prose, not a form

Each voice block is the whole system prompt for one task, stored as text.

It would be possible to atomise them — a field for forbidden words, a field for tone traits, a list for preferred slang. That is deliberately **not** done yet, for one reason: the prose already contains those rules. Splitting them into structured fields while the prose still holds them creates two sources of truth for the same rule, and the one you edit is not necessarily the one the model reads. That is the exact bug class that put caption limits in two places (see PLAN.md Phase 3.3).

Extraction can happen later, once the blocks have stopped moving — and it will have to remove the rule from the prose in the same commit.

## Placeholders

Any voice block may reference identity fields:

```
{{handle}} {{displayName}} {{pronouns}} {{ageBand}} {{nationality}}
{{locale}} {{languages}} {{niche}} {{audience}}
```

`{{languages}}` renders comma-joined. Whitespace inside the braces is fine.

An **unknown** placeholder is rejected at write time — a typo like `{{hadnle}}` would otherwise render literally into a live prompt. If one somehow reaches rendering, it is left verbatim rather than blanked: a visible `{{hadnle}}` is far easier to spot than a silently missing clause in a 200-line prompt.

## Fail-closed — the rule that matters

[runtime-config.ts](../apps/api/src/services/runtime-config.ts) fails **open**: before its first database read it returns defaults, because a default reply cap is harmless.

[profile/resolver.ts](../apps/api/src/services/profile/resolver.ts) fails **closed**. If the persona were config with an open fallback, a worker tick during the ~200 ms boot window would generate a reply *in a default voice* and publish it to a real account. There is no undo on a published reply.

So `getProfile()` returns `null` until the row is genuinely loaded, and it stays `null` on a database error or a malformed row. Callers pick a posture:

```ts
systemPromptFor(task)      // throws  — request paths, a person is waiting
trySystemPromptFor(task)   // null    — the reply worker, which must SKIP
```

The reply generator returns `shouldReply: false` when the profile is not loaded. The comment stays queued and the next tick picks it up. **A skipped reply is recoverable; one published in the wrong voice is not.**

The cache also keeps its last good value rather than reverting on a later failure, so a transient database blip cannot silently swap the account back to a built-in voice.

## Prefix-cache stability

DeepSeek bills a cached prompt prefix at a fraction of the miss price, and it is the largest recurring cost lever in this system. The composer produces the entire stable prefix. Volatile data — the comment being replied to, today's date, the specific post — is appended by callers as *user* messages and never mixed into what `composeSystemPrompt` returns.

A **config** edit legitimately busts the cache once; the UI says so on every voice save. A **code** change that alters the composed output silently multiplies the bill, which is what the hash test in [compose.test.ts](../apps/api/src/services/prompt/compose.test.ts) exists to catch:

```
prefix stability > has a stable hash across the whole seed profile
```

If that fails and you did not intentionally edit a prompt, you have introduced a cost regression. To update it deliberately: run the suite, copy the received hash into the inline snapshot, and say why in the commit message.

> **Known cache gap:** the reply generator samples its few-shot `StyleExample` rows with a random `skip`, so the portion of the request after the system prompt varies per call. The system prompt itself — the bulk — still caches. Making the sample deterministic would recover the rest, but it would also reduce reply variety, so it is a deliberate open question rather than an oversight.

## Versioning

Every save snapshots the **outgoing** state into `ProfileVersion` before writing, so version *N* in the list is what the profile looked like before edit *N+1*. Rollback is a forward write: restoring v3 creates a new version whose content equals v3, and never rewrites history.

This is not optional decoration. Voice config is free text feeding an LLM that publishes to a real account — you will eventually make an edit that makes replies worse, and raw JSON diffs are not how you will notice. The `/profile` page also renders any block *as the model will see it*, before saving.

## Seeding

On boot, [`ensureProfileSeeded`](../apps/api/src/services/profile/resolver.ts) creates the default row if it is missing, built by [seed.ts](../apps/api/src/services/profile/seed.ts) from the constants that used to be hardcoded. It is **idempotent** — an existing row is never overwritten, so a redeploy cannot clobber an edited voice with the factory default.

`seed.ts` *imports* those constants rather than re-typing them: transcribing a 200-line prompt by hand is a silent-corruption risk, and while both forms exist there must be exactly one copy of the text. The handle is substituted out into `{{handle}}` so renaming the account updates every prompt at once.

The proof that this migration changed nothing is in `compose.test.ts`: every one of the five blocks, plus the subject descriptor, composes **byte-for-byte** back to the constant it replaced. The account cannot tell the difference, so neither should the bytes.

## API

| Route | Does |
|---|---|
| `GET /profile` | current profile + version |
| `PATCH /profile` | partial update; validates the *merged* result, snapshots, bumps version, refreshes cache |
| `GET /profile/versions` | last 50 snapshots |
| `POST /profile/rollback/:version` | restore a snapshot as a new version |
| `POST /profile/preview` | render a draft block against current identity without saving |

`PATCH` validates the merged whole rather than the patch, because a partial edit can still produce an invalid profile.

## When this becomes multi-tenant

The row is keyed `id = "default"` and there is no `userId`. That is deliberate — the scope today is one personal account. Everything is shaped so tenancy is additive: add a `userId` FK, a session guard, and swap the fixed `"default"` lookup for the caller's profile id. No prompt code changes, because no prompt code knows which profile it is using.
