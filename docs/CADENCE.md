# Cadence, platform rules, and the autonomy dial

Three things moved out of the code in Phase 3: **when** the account acts, **what the platforms allow**, and **how much of the loop runs without a human**.

## Cadence — when

Lives in `profile.cadence`, edited at `/profile`.

| Field | Meaning |
|---|---|
| `timezone` | IANA zone. Everything the scheduler does resolves through this. |
| `quietWindows` | Local hour ranges where no reply ever fires. `endH` may exceed 24 to cross midnight. |
| `morningSession` / `eveningSession` | Active bands, in minutes from local midnight. Dynamic sleep windows are placed inside them. |

How many sleep windows there are and how long they run stay in `AppSettings` (Settings page). The split is deliberate: cadence holds facts about the account, `AppSettings` holds knobs you tune weekly. They are read together in `getDynamicSleepWindowsForDay`.

Cadence **fails open** to defaults that reproduce the old hardcoded constants exactly. That is the opposite of voice, and the difference matters: replying on a sensible default schedule is harmless, whereas replying in a default *voice* is not. See [PROFILE.md](./PROFILE.md#fail-closed--the-rule-that-matters).

### Timezone and DST

The scheduler used to assume a fixed `UTC+5:30` with an explicit "no DST" comment, and converted by subtracting a constant. That is correct for `Asia/Kolkata` and wrong for every zone that observes DST.

[tz.ts](../apps/api/src/services/tz.ts) resolves local wall-clock times to absolute UTC instants using the zone's **real offset on that date**. Nothing subtracts a constant.

Why it matters concretely: a spring-forward local day is 23 hours long. Under the old math a sleep window at local 16:00 was computed as "local midnight + 960 minutes", which on that day lands at 15:00. An hour of intended quiet time becomes active, and an hour of intended active time is treated as asleep — silently, once a year, with no error anywhere.

Two edge cases are deliberate and tested:

- a local time inside the **spring-forward gap** does not exist, so it resolves to the instant one offset-step before it (02:30 reads back as 01:30)
- an **ambiguous fall-back** time resolves to the first occurrence

Neither throws. The reply worker must not die once a year on a calendar quirk, and both land within an hour of the requested boundary — well inside the tolerance of a window that is already randomised by tens of minutes.

Every local time that *does* exist round-trips exactly, including every other hour of both transition days.

### The quiet-hours rail

`MIN_QUIET_HOURS_PER_DAY = 6` is a constant in code, not a setting. A schedule with no quiet time is a bot pattern, and the human-cadence defence is the main thing standing between this system and an action-block on an irreplaceable account.

**Preferences are configurable; rails are not.** `PATCH /profile` refuses a cadence whose quiet windows total less than the rail, and refuses a session shorter than an hour (there would be no room to place a sleep window).

Changing the timezone applies from the next local midnight — the current day's windows are already frozen by the per-day memo, so an edit cannot reshuffle a schedule that is already running.

## Platform rules — what is allowed

[packages/shared/src/platform-rules.ts](../packages/shared/src/platform-rules.ts) is the one place caption caps, media bounds, mime types and fold cutoffs are written down. Imported by the API and the web app alike.

These are **Meta's rules, not preferences**. 2200 characters is a fact about Instagram; making it configurable would only let someone configure their way into a guaranteed API rejection. Creator preferences that sit on top — favoured caption length, emoji policy, the bait-phrase list — belong in the profile.

### The bug this closed

The rules used to be written twice: once in the composer's `TYPE_CONFIG` and once in `CreateBody.superRefine`, with nothing keeping them equal. `UpdateBody` had neither.

So `PATCH /posts/:id` accepted a Threads caption over 500 characters and a 1-item carousel — both guaranteed Meta rejections — and they went straight to the publish queue, where the 3-attempt retry burned on something that could never succeed. Editing a queued post is a normal path, so it was reachable.

Both write paths now run `validatePost`, and the composer reads the same table.

### Draft vs publish

A post still being assembled may legitimately be incomplete: no image chosen yet, one slide of a planned carousel, the first line of a chain. Blocking that would mean you cannot save work in progress.

So `validatePost` takes a stage:

| Rule | draft | publish |
|---|---|---|
| caption cap | enforced | enforced |
| caption on a type that takes none | enforced | enforced |
| type/platform mismatch | enforced | enforced |
| **too many** media | enforced | enforced |
| **too few** media | allowed | enforced |
| chain shorter than 2 segments | allowed | enforced |

The stage comes from `scheduledAt`: a post with no scheduled time is a draft.

**The route schema can only see the patch.** A `PATCH` that omits `scheduledAt` on an already-queued post would read as a draft and skip the minimums. So `updatePost` re-runs the same validator against the **merged** post, using the stored row's real state. The schema check is an early filter; that one is authoritative.

## The autonomy dial — how much runs unattended

[autonomy.ts](../apps/api/src/services/autonomy.ts). Each stage of the loop carries its own level:

| Level | Behaviour (`decide()` → `act`) |
|---|---|
| `off` | `skip` — the stage does not run |
| `suggest` | `draft` — produces output, parks it, notifies |
| `review` | `gate` — produces and schedules, holds until approved |
| `auto` | `proceed` — runs unattended |

Stages: `plan` → `generate_media` → `write_caption` → `schedule` → `publish` → `reply` → `learn`.

Full autonomy that cannot be partially disengaged is unshippable. Per-stage levels are what make a rollout answerable: promote one stage, watch a week, promote the next. If quality drops you know which change caused it.

Defaults reproduce today's behaviour exactly — `publish`, `reply` and `learn` at `auto`, everything else `off`, because nothing else exists yet. The gate is in place *before* there is anything to gate, which is the cheap time to add it.

**This is a rollout control, not a security boundary.** It exists so a human can decide how much of the loop runs unattended, not to defend against a hostile caller. When the profile has not loaded it falls back to those built-in defaults rather than denying, because denying `publish` would halt the product on every boot.

Callers switch on `decide(stage).act` rather than re-deriving the level, so the mapping from level to behaviour lives in one place and cannot drift between stages.
