Quick wins — S effort (~1 day each), do these next
Ranked roughly by leverage:

Trust + correctness (start here — unblock everything else)
Round-trip the full Post on edit — fix silent data wipe. Verified bug in apps/web/components/compose-dialog.tsx (line ~130) — editing a queued post drops igExtras, replyChainJson, PostAsset.altText, userTagsJson because the calendar list payload omits them. Add api.getPost(id) to apps/web/lib/api.ts, optimistically hydrate basics from editingPost, patch extras after GET resolves. This is the unspoken reason you avoid editing queued posts. Prerequisite for the Threads-duplicate bigger bet.

Token-expiry visibility + manual refresh. Today the refresh loop only logs to console — silent failures only surface when publishing breaks (total outage). Add lastRefreshAt + lastRefreshError columns (schema.prisma), have services/token-refresh.ts write them on every touch, surface in the topbar (amber <14d, red <7d only when lastRefreshError set — healthy auto-refresh stays silent). POST /accounts/:id/refresh-token with 5-min server cooldown.

Add Post.publishedAt as a real column. Today "time since publish" reuses updatedAt, which any edit corrupts. Add the column, worker sets on successful publish, backfill once from updatedAt for current rows. Unlocks honest velocity analytics — derive firstHourCommentCount from existing EngagementComment.receivedAt at insight-sync time (no extra polling).

Drop ANTHROPIC_* env vars + Redis docker-compose block. Verified-dead-only trim. Memory explicitly bans Claude, so a stale ANTHROPIC_API_KEY is a rotation/leak footgun on every secrets audit. Remove from env.ts. Remove the Redis service block + smm_redis_data volume from infra/docker-compose.yml. Skip the bullJobId migration (saves nothing).

Compose-time quality (where it actually helps)
Compose-time hard blocks for realistic publish failures. Today the 3-attempt retry exists for transient Meta failures, but most rejections are deterministic and catchable client-side. Hard-block at compose + in POST /posts: PNG-attach-to-IG (2-line mime+platform check), caption length per platform with live counter (IG 2200, Threads 500), carousel asset count <2 or >10. Zero memory cost, zero migration.

Hook Check + "Rewrite first line" button — deterministic, zero-LLM on keystroke. Pure-TS in compose-dialog.tsx: first-line char count vs platform cutoff (55 for ig_reel, 125 for ig_feed/carousel — what 95% see), regex match on bait list ("comment YES", "tag a friend", "double tap if", "save this"). Render as badges, not 1-5 scores (avoids fighting BRAND_VOICE toward marketing polish). A separate "Rewrite first line" button is the only thing hitting DeepSeek — on click only, instructed to preserve lowercase mid-thought brand voice.

Caption-only lint — shared apps/web/lib/caption-lint.ts util. Soft inline warnings for corporate words (elevate/unlock/leverage), engagement-bait phrases, end-stacked emoji clumps. Critical: do NOT apply to replies (which intentionally stack emojis and use Hinglish) and do NOT apply to image-prompt scene text — captions are the only surface where these patterns hurt.

UX
Toast undo for cancel/delete by reusing existing soft-delete semantics. DELETE /posts/:id already does soft status='cancelled'; engagement cancel sets 'skipped'. Both recoverable. Add POST /posts/:id/restore (→draft) and POST /engagement/comments/:id/restore (→queued, gated on fireAt still in future). Frontend toast with Undo on existing DELETE calls. Zero schema migration.

Auto-save draft on dialog close + show drafts list on mobile. Single auto-save when ComposeDialog closes via X/Esc/route-change if caption.length >= 10 || media.length > 0. Track returned id so reopen-then-close PATCHes the same row. Make the existing right-rail Drafts card visible below xl: (currently xl:flex hidden). 30-day TTL sweeper for untouched drafts.

IST badge everywhere + replace generic shortcuts with IST-peak chips. Tiny "IST" badge on scheduledAt input, calendar labels, engagement-panel fireAt, dashboard timestamps via a renderIst helper in apps/web/lib/time.ts using Intl.DateTimeFormat({timeZone:'Asia/Kolkata'}). Validate against your PostInsight history first — folk-wisdom peaks (Sat 8:30PM, Tue 8PM, Thu 8PM IST) may or may not match Aisha's actual data.

Insight
Share-rate + save-rate sub-lines under engagementRate tile. From existing PostInsight data. IG-only — hide on Threads (no saves). Surface "your top share-heavy posts this month" backed by dashboard-engagement-mix.ts. Label accurately as share-rate, not "DM-shareability" — Meta's field rolls in DM sends.

DeepSeek prompt-cache telemetry + frozen-prompt CI test. Don't refactor — audit. (a) Log usage.prompt_cache_hit_tokens / _miss_tokens for a week. (b) Unit test that hashes each SYSTEM_PROMPTS constant and fails CI when hash changes without an explicit "cache-bust ack" comment. Protects your stated #1 cost lever from accidental breakage (date injection, etc.) without speculative refactor.

Growth
First-comment AI question with randomized delay (opt-in, default OFF, per-post checkbox). Single AI-generated open-ended first comment with randomized 2-15 min delay (NOT fixed 30s — avoids fingerprint). Reuses style-learning prompt so voice doesn't drift. No /pin call (not well-documented public IG endpoint). Skip ig_story, threads. A/B compare before commit.

Trial Reel toggle in compose for ig_reel setting trial_params.graduation_strategy=SS_PERFORMANCE (Meta auto-graduates). Follower-count guard hides the toggle when followers_count < 1000. Feature-flag auto-disables if trial_params POST returns 400 on first attempt so normal publishing never breaks. Documented to lift non-follower reach.

Carousel companion text on existing 3-image-prompt set. Extend services/ai.ts so the existing 3-image-prompt return adds: one master IG caption + 3 short Threads-length micro-captions matched 1:1 to slides + per-slide alt text. Natural extension of your live flow, on-persona, zero new tables.

Bigger bets — L effort (~3-7 days each)
Meta webhooks + hot-post 60s poll burst for first 30 min. Finish the stubbed POST /webhooks/meta — verify X-Hub-Signature-256 (scope @fastify/raw-body to /webhooks/meta only), parse entry[].changes[].value, dedupe on platformCommentId, insert via planReplyTime(). Subscribe separately to Threads replies/mentions and IG comments. Keep the 8-min poller as 30-min safety-net (cold Fly machines drop webhooks). Hot-post table: when SMM publishes, register post_id; comment poller checks only hot posts every 60s for 30 min (~30 extra reads/post), then expires. Closes "comments stale before reply queue" without burning the recently-hardened read budget. Files: routes/webhooks.ts, services/engagement.ts, engagement-worker.ts.

Threads-native second channel: "Duplicate as Threads draft" from any IG post. Add button on any IG post in calendar/dashboard → creates a separate threads_post Post row with caption pre-filled by existing suggestCaptions(platform:'threads') (already supports 500-char / no-hashtag rules). Optional source_post_id FK for analytics linkage. No dual-publish, no partial-failure semantics. Cheapest credible way to give Threads its own voice without rewriting the publish worker. Files: routes/posts.ts, calendar/dashboard menu, schema.prisma.

Backups: gzip+gpg pg_dump streamed to Cloudflare R2 free tier (10GB) + restore drill. Daily pg_dump piped through gzip then gpg-symmetric-encrypt (env passphrase) directly to R2 via multipart PUT — never buffer to disk/RAM. 7 daily + 4 weekly snapshots. Replace setInterval with "last backup >23h ago" check on every worker tick so Fly restarts don't skip days. Add /admin/backup/restore-test that pulls latest dump, restores into temp schema, asserts row counts, drops — untested backups don't count. Encryption mandatory because DB holds Meta long-lived tokens + persona PII. Files: new services/db-backup.ts, engagement-worker.ts, new routes/admin.ts.

Topic-tag suggester + per-post tagging for Threads. Per-post topic-tag picker in compose-dialog.tsx, backed by DeepSeek free-text suggestion from caption (no curated taxonomy). For the 10 profile-bio topic tags, surface a static "suggested profile topics" card in /settings — copy-paste-ready strings the user adds manually in the Threads app (no documented write API as of mid-2026). One-off curl test against Aisha's token first before building UI. Closest thing to "unclaimed algorithmic real estate" on Threads.

Stage 3 prep — Persona Era + voice anchoring (not full diary autopilot). A single editable "Current Era" string in /settings (e.g. "Goa week, soft-launching mystery R, tissue saree phase") appended after the stable BRAND_VOICE block (preserves DeepSeek prefix cache). Weekly "suggest next era from scheduled posts" button — manual accept/edit/reject, no autonomous cron. Tiny era_history table. No fabricated events, no 6-week orchestrated arcs (breaks for a fictional persona without a consistent image pipeline). Delivers ~80% of the "persona doesn't drift" benefit at ~10% of the cost.

Research topics — answer before committing
Run these as 1-2 hour investigations:

Verify per-post topic-tag write API on Threads with Aisha's live token — one-off curl test before building the topic-tag bigger bet.
Validate proposed IST peak chips against PostInsight — one-time SQL aggregation by IST hour-of-week; if data doesn't confirm, label the chips "rule of thumb."
Confirm IG Graph /pin endpoint availability for IG Business accounts in mid-2026 — changes whether the first-comment feature is worth extending.
Measure current DeepSeek prompt_cache_hit_tokens ratio at all 4 call sites for one week — gates any future prompt-architecture work.
Test trial_params.graduation_strategy=SS_PERFORMANCE end-to-end with one real Trial Reel. Avoids shipping a toggle that 400s on first use.
Audit Meta webhook delivery reliability to a Fly machine that auto-sleeps. Drives whether the safety-net poll can drop to 30 min or needs to stay at 8.
Killed highlights — interesting ideas that didn't survive
These were tempting but turned out to be traps:

Self-MCP server exposing SMM to Claude.ai — public-internet publish endpoint on a 256MB box for a single irreplaceable account; one leaked key = attacker schedules unauthorized content.
"Meta Competitive Insights API" niche-audio scout — that API doesn't exist in mid-2026; Business Discovery returns only basic public metadata. Building it forces scraping.
LiteLLM router DeepSeek → Groq → Cerebras fallback — solves a non-problem (reply-generator falls back to manual queue by design) and breaks the DeepSeek prefix-cache discount.
Shadowban early-warning card from non-follower reach baseline — PostInsight only stores aggregate reach; the follow_type split lives only in the IG app UI. Fallback math fires false positives on normal variance.
C2PA metadata stripper before upload — inverts your "never risk the account" constraint with explicit AI-disclosure evasion. Meta runs pixel-level classifiers independent of C2PA, so client stripping is mostly theater anyway.
Comment-velocity escalator dropping sleep windows on viral posts — 4hr window bypass per viral post erodes the human-pattern defense protecting the account; sub-10min polling fights the read budget.
Audio-trend radar via hashtag top_media — Meta deliberately strips audio_id from other users' Reels; only your own Reel exposes original_sound_info. Anything that surfaces this is scraping.
Where I'd start
If I had to pick three to ship first:

#1 quick win — the publish-edit data-wipe fix. Pure correctness, unblocks the Threads-duplicate bigger bet, restores trust in the calendar.
#2 quick win — token-expiry visibility. Cheap safety on the single irreplaceable account.
Bigger bet #3 — encrypted backups to R2. Months of StyleExample and PostInsight data are one bad migration from gone. R2 free tier is honest zero-cost.
Then the Threads-duplicate bigger bet, since that's where the cross-platform growth lever is sitting.

Want me to plan + ship any of these?