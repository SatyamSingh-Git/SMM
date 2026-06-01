# Autonomous Engagement — the Threads auto-reply agent (Stage 2)

The system watches your **Threads** posts for new comments and replies to them automatically, in your voice, on a human-like schedule, with hard safety rules and a kill switch. This is the closest thing to an "AI agent" in the project.

> **Scope:** the comment poller, the reply runner, the reply generator (persona + rules), reply scheduling, style learning, the engagement UI, every safety guardrail, and all config. For publishing see [SCHEDULING.md](./SCHEDULING.md); for the analytics view of replies see [DASHBOARD.md](./DASHBOARD.md).
>
> **Platform note:** auto-reply currently runs on **Threads only** (Instagram comment automation isn't wired). Meta webhooks exist only as a stub ([routes/webhooks.ts](../apps/api/src/routes/webhooks.ts)) — the system **polls** rather than relying on webhooks.

---

## 1. The pipeline end to end

```
engagement-worker.ts
  ├─ comment poller (every 10 min) ──► pollForNewComments()  [services/engagement.ts]
  │     listMyPosts(7d) → fetchConversation(post) → for each NEW top-level comment:
  │        skip if it's ours / already replied in the subtree / already ingested
  │        skip-but-record if before ENGAGEMENT_REPLY_AFTER or over the daily cap
  │        else: create EngagementComment(status=queued, fireAt=planned time)
  │
  ├─ reply runner (every 60s) ──► processDueReplies()  [engagement-worker.ts]
  │     find queued comments with fireAt <= now → for each:
  │        status=replying → re-check daily cap
  │        generateThreadsReply()  [services/reply-generator.ts]  (DeepSeek + persona + your style)
  │        if shouldReply=false → status=skipped (reason)
  │        JSON-leak safety gate → if reply looks like raw JSON → status=failed
  │        publishItem(replyToId=comment) → status=replied (store reply + platform id)
  │
  └─ style learning (on boot if <20 examples, then every 12h) ──► learnThreadsStyle()
        scans your past Threads, extracts (their comment → your reply) pairs → StyleExample rows
        these become few-shot examples for the generator → it sounds like YOU
```

All three loops live in [apps/api/src/engagement-worker.ts](../apps/api/src/engagement-worker.ts). In production they run inside the main API process (gated by `ENGAGEMENT_ENABLED`); in local dev you must start the runner explicitly (`pnpm --filter @smm/api engagement-worker`).

---

## 2. Data model

### `EngagementComment` ([schema.prisma](../packages/db/prisma/schema.prisma))
One row per top-level comment we've seen on one of our posts.
- `platformCommentId` (unique), `platformPostId`, `parentPlatformId`, `postCaption`
- `authorUsername`, `authorPlatformId`, `text`, `receivedAt`
- `status` (state machine below), `agentReplyText`, `agentPlatformReplyId`, `lastError`
- **`fireAt`** — when the reply should fire (Postgres scheduling; null = fire ASAP)
- indexes on `(status, fireAt)`, `(status, receivedAt)`, `platformPostId`, `authorPlatformId`

### `EngagementStatus` state machine
```
            ingest                 reply runner claims
(comment) ──────────► queued ──────────────────────────► replying ──► replied
                        │                                    │
   already-replied /    │                                    ├─► skipped  (agent declined / cap / cutoff)
   over cap / cutoff ───┼─► skipped (recorded, never fires)  └─► failed   (send error / JSON leak)
                        │
   manual "skip" ───────┴─► skipped       manual "retry" (failed) ──► queued
```
`new` exists in the enum but in practice comments are created directly as `queued` (or `skipped`).

### `StyleExample` ([schema.prisma](../packages/db/prisma/schema.prisma))
A learned `(questionText, answerText)` pair — a real past comment and your real reply — plus `postContext` and a unique `platformReplyId` (dedupe). Used as few-shot context so the generator imitates your actual voice.

---

## 3. Comment polling ([services/engagement.ts](../apps/api/src/services/engagement.ts) → `pollForNewComments`)

Runs every 10 min (and via the manual **poll-now** button). Returns `{scanned, queued, skipped}`.

1. Find the Threads `Account`; decrypt its token.
2. `listMyPosts(7d, limit 25)` — only look back `LOOKBACK_DAYS = 7` (bounds API usage; older comments rarely worth replying to).
3. For each post, `fetchConversation(postId)` → the full reply tree. Build a parent→children map.
4. **Top-level comments** = direct replies to the post. For each:
   - **Skip if it's ours** (author == our user id) or empty text.
   - **`subtreeHasAuthor`** — if we (or the agent) already replied *anywhere* in that comment's subtree → record as `skipped` (we reply at most once per conversation branch, then leave the rest to the human).
   - **Dedupe** — if we already have a row for this `platformCommentId`, do nothing (or downgrade a stale `new`/`queued` to `skipped` if we since replied).
   - **Resume cutoff** — if `ENGAGEMENT_REPLY_AFTER` is set and the comment was created *before* it → record `skipped` with a note. (Use after an outage so the bot doesn't reply to a stale backlog.)
   - **Daily cap** — if `isOverDailyCap()` (≥300 committed today) → record `skipped` ("daily cap reached"), still visible in the UI for manual reply.
   - Otherwise → **create `EngagementComment(status=queued, fireAt=plannedTime)`** and count it as queued.

---

## 4. Reply scheduling ([services/reply-schedule.ts](../apps/api/src/services/reply-schedule.ts))

The whole point is to **not look like a bot**. `planReplyTime()`:
1. Adds a random **3–10 minute** delay (`3*60000 + rand(0..7min)`).
2. **Pushes past IST quiet windows** — no replies fire during these IST (UTC+5:30) hours:
   - `00:00–06:00` (sleeping)
   - `11:00–12:00`
   - `14:00–16:00`
   If the jittered time lands in a window, it's bumped to the window's end + 0–3 min jitter (so deferred replies don't all fire at the boundary at once).
3. The result is stored as `fireAt`. The reply runner only sends when `fireAt <= now`.

**Daily cap:** `DAILY_REPLY_CAP = 300`. `todaysReplyCount()` counts comments with `status in (queued, replying, replied)` whose `receivedAt` is within today (IST) — so in-flight comments count and we never overshoot. `isOverDailyCap()` is checked both at ingest and again right before sending.

---

## 5. The reply runner ([engagement-worker.ts](../apps/api/src/engagement-worker.ts) → `processDueReplies` / `processOneReply`)

Every **60s** (`REPLY_POLL_MS`), guarded by a flag so ticks don't overlap:
1. **Stuck recovery** — `replying` for >15 min → reset to `queued`.
2. Find up to 5 `queued` comments with `fireAt <= now` (or null), oldest `fireAt` first.
3. For each (`processOneReply`):
   - If `KILL_SWITCH` → throw (won't reply).
   - Claim → `status=replying`.
   - **Re-check the daily cap** → if over, `status=skipped`.
   - `generateThreadsReply({postCaption, authorUsername, commentText})` (§6).
   - If `shouldReply=false` → `status=skipped` with the reason.
   - **JSON-leak safety gate** — if the reply text starts with `{`/`[` or contains a `shouldReply:` fragment, it's a malformed model output → `status=failed`, *never sent*.
   - **Send** — `publishItem(account, token, {text: reply, replyToId: comment.platformCommentId})` → `status=replied`, store `agentReplyText` + `agentPlatformReplyId`.
   - On any error → `status=failed` with the message.

Other boot loops in the same file: **comment poller** (first run 15s after boot, then every 10 min), **style learning** (bootstrap 45s after boot if <20 examples, then every 12h).

---

## 6. The reply generator ([services/reply-generator.ts](../apps/api/src/services/reply-generator.ts))

`generateThreadsReply()` → DeepSeek (`DEEPSEEK_MODEL`, max_tokens 250). Returns a `ReplyDecision`:
```ts
{ shouldReply: true,  reply: "<her reply>", reason: null }
{ shouldReply: false, reply: null,         reason: "<why>" }
```

### Persona (system prompt)
"You ARE @cute_aisha_vibes — a 19–21 yo Indian girl on Threads. You are typing, not narrating." Baseline personality: naughty (cheeky, never crass), flirty-first, playful, cheerful, cute, **zero shy**, main-character energy. Always **female first-person** ("I/me/my"). Receives compliments with a smirk, teases back, never gets flustered.

### Few-shot from YOUR real replies
Before generating, it pulls a random sample of up to **18 `StyleExample`** rows (your actual past comment→reply pairs) and injects them as "match this rhythm exactly." This is what makes replies sound like you and not a generic chatbot. If there are no examples yet, it falls back to the persona alone.

### HARD RULES (override everything, including the examples)
1. **Never address anyone** as: `jaan`, `janu`, `lover`, `your love`, `your lovely`, `my love`. (Use `yaar`, `babe`, `boyy`, `ji`, `aap`, a username, or nothing.)
2. **Never say:** "I love you" / "love you too", any explicit sexual offer, anything about removing clothes / private parts / sending nudes — anything sexually explicit.
3. **Tiered handling of suggestive comments:**
   - **(a) Mild** (imagining, kissing, curves, "what's inside") → reply with shy energy, `🤭` (often stacked `🤭🤭🤭🤭🤭`). Light tease back OK; **never confirm, agree, or escalate.** The 🤭 *is* the answer.
   - **(b) Explicit** (clothes off, private parts, sexual acts, nudes) → **SKIP** (`reason: "explicit comment"`).
   - **(c) Contact / platform-switch / follow requests** ("DM me", "follow back", "WhatsApp number", "let's meet", "insta pe aao", "video call", "add me on snap/telegram", etc., in English/Hinglish/Hindi) → **ALWAYS SKIP** (`reason: "contact / platform-switch / follow request"`). No soft decline.
4. **Never reveal being an AI/bot/model.** If a comment asks or accuses (AI / bot / real / fake / ChatGPT / "is this a script") → **SKIP** (`reason: "AI-identity probe"`). No denial, no clarification.
5. **Emoji count 3–6** per reply. Stacking allowed (`🤭🤭🤭🤭🤭`). Emoji-only replies allowed (`😜😉👀`).
6. **Always reply in the Latin/Roman alphabet** — even when the comment is in Devanagari or another script. Never output Devanagari. (E.g. `अतिसुंदर 👌` → `thank youu 🤭🩷✨ aapne dil khush kar diya 🥰`.)

### Reply style
0–15 words, sometimes lowercase, sometimes one word + emoji, sometimes emoji-only. Mirror the comment's energy and raise it one notch (short Q → cheeky short A; tease → tease harder; compliment → flirty acceptance with a smirk; "good morning" → "good morning ji 😉🩷"). Never lectures, never repeats the question, never opens with "Thanks for your comment". Shy mode is *only* for mild-suggestive (rule 3a); default is confident-flirty.

### REPLY vs SKIP
- **Reply** when it's a clear question/compliment/tease/reaction it can match naturally, ≥70% confident she'd engage.
- **Skip** when: unclear/gibberish/unparseable script; just an emoji with no context; creepy/sexual/hostile/insulting; would require inventing a personal fact; spam/brand-pitch/giveaway/follow-for-follow; a real reply would feel forced.

### Robustness (DeepSeek quirks)
- **First attempt** uses JSON mode (temp 0.85). DeepSeek sometimes stalls on short emoji-heavy / Devanagari input and returns empty.
- **One retry** without JSON mode (temp 0.95) for *mechanical* failures only (`empty model output`, `model output not parseable`, `empty reply text`, `non-object output`) — deliberate skips are not retried.
- **Forgiving parser** (`parseDecision`): direct JSON → strip code fences → extract first `{…}` block → last-resort treat a short non-refusal plain-text as the reply. `normalize()` accepts snake_case + alt field names (`should_reply`, `text`/`message`/`content` for the reply, `why` for reason) and caps the reply to 500 chars.

---

## 7. Style learning ([services/style-learning.ts](../apps/api/src/services/style-learning.ts) → `learnThreadsStyle`)

Walks your recent Threads posts (up to 100), fetches each conversation, and extracts every `(their comment → your reply)` pair: for each node authored by *you* that replies to someone *else's* non-empty comment (excluding self-reply chains), it stores a `StyleExample`. Deduped by `platformReplyId` (re-imports are no-ops). Result: `{scannedPosts, pairsFound, inserted, duplicates}`. Runs automatically on boot (if <20 examples) + every 12h, and can be triggered from the UI.

---

## 8. The engagement UI ([components/engagement-panel.tsx](../apps/web/components/engagement-panel.tsx))

Lives in the calendar page's right rail. Shows the live state of the agent:
- **Header** with a **↻ poll-now** button (`POST /engagement/poll-now`).
- **Two stat tiles:** *Style learned* (StyleExample count) and *Replies today* (`repliesToday / 300`, turns red at the cap).
- **Status tabs:** All / Queued / Replied / Failed (with counts from `/engagement/stats`).
- **Comment cards** (`CommentRow`), auto-refreshing every 15s:
  - Status badge, @author, relative time, the comment text, the post caption it's on.
  - **Replied** → shows the agent's reply in an accent box.
  - **Skipped** → shows the reason. **Failed** → shows the error.
  - **Queued/new** → a **Preview reply** drawer (`POST /engagement/comments/:id/preview`) that dry-runs the generator (no send, no DB write) so you can see what it *would* say, plus a ↻ to regenerate. A note warns the live reply may differ slightly (style examples evolve).
  - **Actions:** queued/new → **Skip** (`cancel`, with confirm — you'll reply yourself); failed → **Retry**.

---

## 9. Engagement API reference ([routes/engagement.ts](../apps/api/src/routes/engagement.ts))

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/engagement/comments?status&limit` | List recent comments (max 200), newest first. |
| `GET` | `/engagement/stats` | Counts per status + `styleExamples` + `repliesToday`. |
| `POST` | `/engagement/learn-style` | Run style learning now. |
| `POST` | `/engagement/poll-now` | Poll Threads for new comments now. |
| `POST` | `/engagement/comments/:id/cancel` | Mark a queued comment `skipped` (reply manually). |
| `POST` | `/engagement/comments/:id/preview` | Dry-run the reply generator (no send, no write). |
| `POST` | `/engagement/comments/:id/retry` | Re-queue a failed comment (`fireAt=now`). |

Client methods: `listEngagementComments`, `engagementStats`, `learnStyle`, `pollEngagementNow`, `cancelEngagement`, `retryEngagement`, `previewEngagementReply` ([lib/api.ts](../apps/web/lib/api.ts)).

---

## 10. Safety guardrails (the full list)

| Guardrail | Where | Effect |
|---|---|---|
| **Kill switch** | `KILL_SWITCH=true` ([env.ts](../apps/api/src/env.ts)) | Reply runner refuses to send; publishing also halts. |
| **Enable flag** | `ENGAGEMENT_ENABLED=false` | The whole engagement runner is not started in prod. |
| **Daily cap** | `DAILY_REPLY_CAP=300` ([reply-schedule.ts](../apps/api/src/services/reply-schedule.ts)) | Checked at ingest *and* at send; excess recorded as skipped. |
| **Rate limiter** | `threads_reply` cap 800/24h ([rate-limiter.ts](../apps/api/src/services/rate-limiter.ts)) | 20% under Meta's 1000/24h reply limit. |
| **Quiet windows** | IST 00–06, 11–12, 14–16 | No replies fire; deferred past the window. |
| **Reply-once-per-thread** | `subtreeHasAuthor` ([engagement.ts](../apps/api/src/services/engagement.ts)) | Never double-reply in one conversation branch. |
| **Resume cutoff** | `ENGAGEMENT_REPLY_AFTER` (ISO ts) | Comments before it are recorded but never replied (post-outage backlog protection). |
| **Content rules** | persona HARD RULES ([reply-generator.ts](../apps/api/src/services/reply-generator.ts)) | Forbidden words/sentences; explicit/contact/AI-probe → skip; never reveals AI; Roman alphabet only. |
| **JSON-leak gate** | reply runner | A reply that looks like raw JSON is blocked (`failed`), never sent. |
| **Human-in-the-loop** | preview + skip/retry buttons (UI) | You can preview, skip, or retry any comment manually. |

---

## 11. Configuration (env vars) ([env.ts](../apps/api/src/env.ts))

| Var | Default | Meaning |
|---|---|---|
| `ENGAGEMENT_ENABLED` | `true` | Start the engagement runner in prod (set `false` to run it elsewhere / pause). |
| `ENGAGEMENT_REPLY_AFTER` | _(unset)_ | ISO timestamp; comments created before it are skipped (recorded, not replied). |
| `KILL_SWITCH` | `false` | Halts all replying + publishing. |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | — / `deepseek-chat` | The reply generator's model. |
| `THREADS_ACCESS_TOKEN` | — | The Threads account whose comments are polled + replied to. |

Tunable constants in code: `LOOKBACK_DAYS=7` (engagement.ts), `REPLY_POLL_MS=60s` / `COMMENT_POLL_MS=10min` / style refresh `12h` (engagement-worker.ts), `DAILY_REPLY_CAP=300` + the 3–10 min delay + quiet windows (reply-schedule.ts).

---

## 12. What's intentionally NOT built (yet)

- **Webhooks** — `GET/POST /webhooks/meta` only does the verification handshake + acks; events aren't processed. The system **polls** instead (simpler, no signature-verification surface, fine at this volume).
- **Instagram comment auto-reply** — Threads only for now.
- **Thread-continuation** (posting follow-ups to keep a hot thread alive) — planned in the roadmap, not built.
- **DMs** — not touched (and Meta's DM automation rules are stricter).

---

## 13. Operating playbook

- **Pause everything fast:** set `KILL_SWITCH=true` (Fly secret) — replies + publishing stop on the next tick.
- **Pause just auto-reply:** `ENGAGEMENT_ENABLED=false`.
- **Coming back after an outage** without bot-replying a stale backlog: set `ENGAGEMENT_REPLY_AFTER` to "now" (ISO) before re-enabling — older comments get recorded as skipped, only fresh ones get replies.
- **Replies sound off:** add more real examples via **Learn style** (the more `StyleExample` pairs, the more it sounds like you), or refine the persona in [reply-generator.ts](../apps/api/src/services/reply-generator.ts).
- **See what it would say** before trusting it: use the **Preview reply** drawer on a queued comment.
- **A comment you'd rather handle yourself:** hit **Skip** on its card.
