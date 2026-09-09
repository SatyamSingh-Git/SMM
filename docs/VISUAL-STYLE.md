# Visual style

The vocabulary the image-prompt writer draws from — outfits, locales, lighting, camera work — is data, not code. Edit it at **`/profile`** under *Visual style*.

## Why

Eight hardcoded key unions in `image-prompts.ts`, roughly 80 entries, described one creator in one genre: a specific country's fashion, a specific set of cities, a specific look. Someone shooting surf photography in Portugal shares approximately none of them, and every change meant editing TypeScript and shipping.

## Shape

One row per selectable value:

| Field | Meaning |
|---|---|
| `dimension` | which axis — `outfit`, `lighting`, or anything you invent |
| `key` | stable slug, referenced by saved drafts |
| `label` | what the picker shows |
| `promptText` | the photography direction fed verbatim to the model |
| `enabled` | soft-delete flag |
| `sortOrder` | display order, spaced by 10 |
| `conflictsWith` | keys that contradict this one (advisory) |

**`dimension` is a free string, not an enum.** Adding a whole new axis — `prop`, `season`, `mood` — is a data insert, not a migration. That is the difference between configurable and merely parameterized, and the UI has an "add a new axis" affordance for exactly that reason. The generator places any dimension it finds; nothing about the eight built-ins is special beyond being seeded.

`sortOrder` is spaced by 10 so a row can be dragged between two neighbours without renumbering the whole dimension.

## The two rules that keep old drafts working

**Delete is a soft delete.** A key still referenced by a saved draft must never be hard-deleted. `DELETE /style-options/:id` sets `enabled = false`; the row stays resolvable and simply leaves the picker.

**A missing key resolves to `null`, never to a string.** `phraseFor()` returns `null` for a key that was disabled or removed after a draft referenced it, and the generator omits that axis. The alternative — the literal text `undefined` landing in a live image prompt — is exactly the failure this guards against. Both properties are mutation-tested.

## Fallbacks

The cache falls back to the built-in constants in [image-prompt-options.ts](../apps/api/src/services/image-prompt-options.ts) until the rows load, so behaviour is identical before and after seeding.

Like cadence and unlike voice, this **fails open**: a missing style option produces a *less specific* prompt, not a wrong one, and image generation is human-triggered anyway. See [PROFILE.md](./PROFILE.md#fail-closed--the-rule-that-matters) for why voice is the opposite.

**An empty table is not treated as a valid configuration.** It means the seed has not run; accepting it would silently strip every director's note from every prompt with no error and no log — just quietly worse output. `refreshStyleOptions` keeps the built-ins until real rows exist.

## Seeding

Per-dimension rather than all-or-nothing: `ensureStyleOptionsSeeded` inserts the built-ins only for dimensions with no rows. Adding a new built-in dimension later seeds only that one and leaves your edits alone.

`POST /style-options/:dimension/restore-defaults` fills gaps in one dimension using `skipDuplicates`, so it never overwrites an edited option.

## Tone bias

The block appended to every image prompt when *default personality* is on used to be a ~10-line string literal inside `buildDirectorsNotes`. It names the subject's proportions and markings, so it is persona config, not mechanism. It now lives in `profile.visual.toneBias`, and an empty value simply omits the block.

### A trap this created, and the fix

Adding a field with a zod `.default("")` **silently switches its behaviour off** for anyone whose profile row predates it. The row parses fine, the new field reads as empty, and the block it controls just stops being emitted — no error, no log.

`backfillProfileDefaults()` handles it, keyed on the field being **absent** rather than empty: an empty string that is *present* means the user cleared it deliberately, and that is respected. Four tests cover it.

Any future field added to the profile schema needs the same treatment. A `.default()` is not a migration.

## API

| Route | Does |
|---|---|
| `GET /style-options` | all rows, grouped by dimension |
| `POST /style-options` | create (409 on a duplicate `dimension/key`) |
| `PATCH /style-options/:id` | label, prompt text, enabled, order, conflicts |
| `DELETE /style-options/:id` | soft delete |
| `POST /style-options/:dimension/restore-defaults` | fill gaps from the built-ins |

`GET /ai/image-prompts/options` returns the catalog the composer renders. It changed from a fixed eight-key object to a `Record<string, …>` so a new axis appears without a code change; the eight built-in keys are still present, so the existing composer is unaffected.

## What is still hardcoded here, deliberately

`IMAGE_PROMPT_SYSTEM` and the **PERSONA LOCK** instruction ("reproduce the descriptor verbatim at the start of each prompt; do not paraphrase; keep the exact tokens"). That is mechanism — how image models hold a subject consistent across a set — not a fact about any particular creator. The descriptor it locks is config; the instruction to lock it is not.
