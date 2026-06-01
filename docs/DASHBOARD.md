# The Dashboard (Stage 1.5 — analytics & insights)

The dashboard's job is stated on the page itself: *"What's working, what's not, what to do next — read by AI on your real performance."* It is **not** just numbers — every section is built to drive an action.

> **Scope:** the `/dashboard` page and all its cards, where each number comes from, the AI insight layer, the insights-sync + backfill pipeline, caching, and every dashboard API endpoint. For composing/publishing see [SCHEDULING.md](./SCHEDULING.md); for auto-reply see [AGENTS.md](./AGENTS.md).

---

## 1. Where the data comes from

The dashboard reads three kinds of stored data, all populated by **manual sync** (a button — no background polling, to save API calls and AI tokens):

```
"Sync now" button  ─► POST /dashboard/sync-insights
                         │
                         ├─ (if <5 posts OR ?backfill=1) backfillFromPlatforms({days:60})
                         │     pulls your existing public posts on IG + Threads into Post rows
                         │
                         ├─ syncPostInsights()      → PostInsight rows (per-post metrics over time)
                         └─ syncAccountSnapshots()  → AccountSnapshot rows (daily follower count)
```

- **`Post`** rows — created by scheduling (SCHEDULING.md) or by **backfill** (your pre-existing posts).
- **`PostInsight`** — one row per metric capture. Captured on a *decaying cadence* after publish: ~1h, 6h, 1d, 3d, 7d, then stops (numbers stabilize). The dashboard always uses the **latest** insight per post.
- **`AccountSnapshot`** — follower count (+ following/posts for IG), captured at most once per ~20h per account → powers the growth chart and follower delta.

### The sync flow ([routes/dashboard.ts](../apps/api/src/routes/dashboard.ts), [services/insights-sync.ts](../apps/api/src/services/insights-sync.ts), [services/backfill.ts](../apps/api/src/services/backfill.ts))

- **`POST /dashboard/sync-insights`** (the **Sync now** button): if the Post table is nearly empty (`shouldAutoBackfill` → <5 published posts in 60d) **or** `?backfill=1`, it first backfills 60 days of your real posts from Meta. Then `syncPostInsights` (50 posts normally, 200 after a backfill) + `syncAccountSnapshots`. Returns `{backfill, post:{scanned,captured,errors}, account:{captured,errors}}`.
- **`POST /dashboard/backfill?days=N`** (the **Force backfill** button): re-pull N days (7–365, default 60) of posts. Use when you've posted manually since the last sync.
- **Backfill detail:** for each platform post not already stored, creates a `Post` (status `published`) with a synthetic `MediaAsset` pointing at the platform's hosted media URL (thumbnail only — never re-published). It rewrites `updatedAt`/`scheduledAt` to the true publish time so all time-window queries work.
- **Insight capture:** `syncPostInsights` looks at posts published in the last 8 days, finds the largest decaying-window that's elapsed since the last snapshot, and captures a fresh `PostInsight` if due. IG metrics are fetched per-metric (tolerating unsupported ones); Threads metrics in one call.

> The dashboard "Sync now" button is the **only** thing that pulls fresh numbers. The page itself just reads what's stored.

---

## 2. The "engagement" number (used everywhere for ranking)

A composite score from a post's latest insight:
```
engagement = likes + comments + saves + shares*2 + reposts*2 + quotes
```
(shares/reposts/quotes weighted because they're higher-intent). Defined in [services/dashboard-analytics.ts](../apps/api/src/services/dashboard-analytics.ts) `getRecentPostsWithLatestInsight`. Some cards use a simpler `likes+comments+saves+shares` for rates — noted per card.

---

## 3. Page layout ([apps/web/app/dashboard/page.tsx](../apps/web/app/dashboard/page.tsx))

Sidebar | main column. Header has the title, the **Sync now** + **Force backfill** buttons (with a live result line: "Backfilled N · +N fresh insights, +N acct snapshot · N errors"). On a successful sync, every dashboard query is invalidated and refetches.

Cards in render order:
1. **Momentum** ("🔥 Breaking out") — only renders if something is breaking out.
2. **AI Insights** (weekly focus + scorecard + wins/warnings/try-next) — unified across both platforms.
3. **Comment Themes** + **Super-fans** (side by side).
4. **Caption Patterns** ("What's working in your captions").
5. **PlatformSection: Instagram** then **PlatformSection: Threads** — each is a full mini-dashboard (KPIs, top performers, follower trend, type breakdown, engagement mix, heatmap).

### Refresh model — two kinds of card
- **AI cards** (DeepSeek-backed): **manual refresh only.** They read a DB cache and never auto-refetch (saves tokens). A ↻ button regenerates. These are: AI Insights, Comment Themes, Caption Patterns.
- **SQL cards** (pure DB aggregation): cheap, so they auto-refetch on an interval. These are: KPIs (5 min), Top performers (10 min), Type breakdown / Follower trend / Heatmap (30 min), Engagement mix, Super-fans, Momentum.

### Caching for AI cards ([services/dashboard-cache.ts](../apps/api/src/services/dashboard-cache.ts), `DashboardAiCache` table)
One row per `kind` (`weeklyFocus`, `commentThemes`, `captionPatterns`). `getCachedOrNull(kind)` returns the stored payload + `generatedAt` + token counts; `writeCached(kind, payload, {input,output})` upserts. Endpoints serve the cache unless `?refresh=1`, which calls DeepSeek, stores, and returns fresh.

---

## 4. Per-platform section ([components/dashboard/platform-section.tsx](../apps/web/components/dashboard/platform-section.tsx))

`<PlatformSection platform="instagram" | "threads" />` renders a self-contained block scoped to one platform (every query passes `?platform=`). It contains: **KpiStrip**, **TopPerformers** + (**FollowerTrend** + **TypeBreakdown** + **EngagementMixCard**), and a full-width **PostingHeatmap**. Two of these on the page = the IG + Threads split.

### 4.1 KPI strip ([components/dashboard/kpi-strip.tsx](../apps/web/components/dashboard/kpi-strip.tsx) ← `GET /dashboard/kpis`)
Four tiles from `getKpis()` ([dashboard-analytics.ts](../apps/api/src/services/dashboard-analytics.ts)):
- **Followers** — current count (latest snapshot). Shows a **+/- N / 14d** delta **only if** there's a snapshot ≥7 days old; otherwise shows "tracking started Nd ago — need 7+ days". This honesty is deliberate: Meta doesn't expose historical follower counts, so deltas come from our own snapshots, and `delta14d` is **null** until we have history.
- **Reach (7d)** — sum of reach (→impressions→views fallback) for posts published in the last 7 days; hint shows posts published.
- **Engagement rate** — `(likes+comments+saves+shares) / reach * 100` over the 7-day posts; null (—) if no reach.
- **Replies (7d)** — count of `replied` engagement comments; hint breaks down replied/skipped/failed. (See AGENTS.md.)

### 4.2 Top performers ([components/dashboard/top-performers.tsx](../apps/web/components/dashboard/top-performers.tsx) ← `GET /dashboard/top-posts?days=30`)
Grid of the top 6 posts by `engagement` (last 30d). Each card: thumbnail (links to the live post), platform badge, an "N eng" pill, caption (2 lines), and per-metric icons (reach/views, likes, comments, saves, shares — only those present). Server returns top 12; card shows 6.

### 4.3 Follower trend ([components/dashboard/follower-trend.tsx](../apps/web/components/dashboard/follower-trend.tsx) ← `GET /dashboard/follower-trend`)
A pure-SVG sparkline (no chart lib) of daily follower totals over 60 days (`getFollowerTrend` sums snapshots by day across accounts). Shows "Now" value + total delta. Needs ≥2 days of snapshots, else an empty state ("give it 24–48h").

### 4.4 Type breakdown ([components/dashboard/type-breakdown.tsx](../apps/web/components/dashboard/type-breakdown.tsx) ← `GET /dashboard/type-breakdown`)
"What works best" — horizontal bars of **avg engagement by content type** over 30d (`getTypeBreakdown`), sorted best-first, with post counts. Answers "should I do more reels or carousels?".

### 4.5 Engagement mix ([components/dashboard/engagement-mix.tsx](../apps/web/components/dashboard/engagement-mix.tsx) ← `GET /dashboard/engagement-mix`)
Pure-SQL ([dashboard-engagement-mix.ts](../apps/api/src/services/dashboard-engagement-mix.ts)). Breaks total engagement into **likes / comments / saves / shares** percentages (saves rolls in Threads reposts; shares rolls in quotes). A **verdict** badge + templated (no-AI) interpretation:
- `save-heavy` → evergreen-friendly intent → make lookbooks/tutorials.
- `share-heavy` → viral signal → mine relatable observations / POV hooks.
- `comment-heavy` → conversational → great for the auto-reply pipeline; bait responses.
- `like-heavy` (dominant signal <8%) → passive → bait comments/shares/saves.
The four tiles show each bucket's % and total.

### 4.6 Best time to post — heatmap ([components/dashboard/posting-heatmap.tsx](../apps/web/components/dashboard/posting-heatmap.tsx) ← `GET /dashboard/heatmap`)
A 7×24 grid (day-of-week × hour) of **average engagement**, color-intensity scaled. `getPostingHeatmap` buckets each published post by its `scheduledAt` **converted to IST (UTC+5:30)**, day index shifted so **Monday = 0**. Darker = higher avg engagement → "post at this time".

---

## 5. AI Insights — the hero card ([components/dashboard/ai-insights.tsx](../apps/web/components/dashboard/ai-insights.tsx) ← `GET /dashboard/ai-insights`, [services/dashboard-ai.ts](../apps/api/src/services/dashboard-ai.ts))

Unified across both platforms (the model benefits from the whole picture). DeepSeek acts as a creator strategist. Manual-refresh-only (↻ button → `?refresh=1`); served from the `weeklyFocus` cache otherwise (generated once on first read).

**Input** to DeepSeek (`generateAiInsights`): last-30d KPIs (with an explicit `deltaAvailable` flag so it never misreads a null delta), type breakdown, and the top 15 posts (caption + all metrics). Params: temperature 0.7, max_tokens 2000, JSON mode.

**Output rendered:**
- **Focus this week** — one hero sentence (`weeklyFocus`), with "Based on N posts across N days · updated …".
- **Scorecard** — three letter grades (A–D) with one-line notes: **consistency**, **engagement**, **growth**.
- **Tabbed lists:** *What's working* (wins), *Watch out* (warnings), *Try next* (ideas, each with a "why" and an optional `exampleCaption` in her voice). 2–4 wins, 2–4 warnings, 3–5 try-next.

**Data-honesty rules baked into the prompt:** never claim "zero growth" when `delta14d` is null (say tracking just started); never invent numbers; if <5 posts of data, say so and fall back to niche best-practices.

---

## 6. Comment Themes ([components/dashboard/comment-themes.tsx](../apps/web/components/dashboard/comment-themes.tsx) ← `GET /dashboard/comment-themes`, [services/dashboard-comment-themes.ts](../apps/api/src/services/dashboard-comment-themes.ts))

DeepSeek reads the **300 most recent Threads comments** (from `EngagementComment`) and returns:
- **Sentiment breakdown** — 4–7 buckets (Flirty / Compliment / Question / Curious / Spam-or-promo / Negative / Other) with counts + up to 3 verbatim examples.
- **Topic clusters** — 3–7 topics people keep asking about (≥2 comments each), each with examples + a **specific content idea** that would answer it (the real payoff: "47% ask about your skincare → post a routine reel").
- **Insight** — a 1–2 sentence "so what".

Manual-refresh-only (cached as `commentThemes`). **Three UI states:** never-generated (a *Generate* button), generated-but-empty (yellow note explaining the source pool was empty), and has-data. Params: temperature 0.4, max_tokens 1800, JSON mode. Token usage is stored with the cache (the ↻ tooltip hints at cost).

---

## 7. Super-fans ([components/dashboard/super-fans.tsx](../apps/web/components/dashboard/super-fans.tsx) ← `GET /dashboard/super-fans`, [services/dashboard-super-fans.ts](../apps/api/src/services/dashboard-super-fans.ts))

Pure SQL (no AI). Groups `EngagementComment` rows from the last 30d by author, keeps those with **≥2 comments**, top 12 by count. Each row: avatar initial, @username (links to the Threads profile), their last comment (italic), comment count, and # of distinct posts engaged on. Framing: *"warm leads — DM them, reply manually, feature them."*

---

## 8. Caption Patterns ([components/dashboard/caption-patterns.tsx](../apps/web/components/dashboard/caption-patterns.tsx) ← `GET /dashboard/caption-patterns`, [services/dashboard-caption-patterns.ts](../apps/api/src/services/dashboard-caption-patterns.ts))

DeepSeek compares the **top 10 vs bottom 10** posts (by engagement, last 30d, posts with metrics) and extracts concrete caption patterns:
- **Do more of** (3–5) — each `{title, detail, evidence}` (e.g. *"Open with 'Boys honestly…' — your top 4 all do, +3.2× engagement"*).
- **Cut back on** (2–3).
- **Templates to copy** (3) — concrete caption drafts in her voice, each with a copy-to-clipboard button.

Manual-refresh-only (cached as `captionPatterns`). Same three-state UI as Comment Themes. The empty payload carries `postsAnalyzed` + a `note` explaining what to do (e.g. "Found N recent posts but none have insight metrics yet — click Sync now"). Params: temperature 0.5, max_tokens 1600, JSON mode.

---

## 9. Momentum ([components/dashboard/momentum.tsx](../apps/web/components/dashboard/momentum.tsx) ← `GET /dashboard/momentum`, [services/dashboard-momentum.ts](../apps/api/src/services/dashboard-momentum.ts))

Pure SQL. Finds posts **published in the last 24h** whose engagement is **≥2× the median** of the user's posts of the **same platform+type** over the last 30 days (median computed from ≥3 peers, excluding the post itself). Renders as a glowing "🔥 Breaking out" banner with each post's multiple (e.g. "3.4×") and `engagement / baseline`. The card returns `null` (renders nothing) when nothing qualifies — so its mere presence is the signal. Action framing: *"ride the wave — post a follow-up while it's hot."*

---

## 10. Platform filtering

Every dashboard endpoint accepts an optional `?platform=instagram|threads`. Omitted = aggregated across both. `PlatformSection` always passes it; the unified AI Insights card never does (it wants the whole picture). The web client helper is `qsPlatform()` in [lib/api.ts](../apps/web/lib/api.ts).

---

## 11. Dashboard API reference ([routes/dashboard.ts](../apps/api/src/routes/dashboard.ts))

| Method | Path | Backed by | Cached? |
|---|---|---|---|
| `GET` | `/dashboard/kpis?platform` | `getKpis` | no (SQL) |
| `GET` | `/dashboard/top-posts?days&platform` | `getRecentPostsWithLatestInsight` (sorted, top 12) | no |
| `GET` | `/dashboard/heatmap?platform` | `getPostingHeatmap(60)` | no |
| `GET` | `/dashboard/type-breakdown?platform` | `getTypeBreakdown(30)` | no |
| `GET` | `/dashboard/follower-trend?platform` | `getFollowerTrend(60)` | no |
| `GET` | `/dashboard/engagement-mix?platform` | `getEngagementMix(30)` | no |
| `GET` | `/dashboard/super-fans?days` | `getSuperFans` | no |
| `GET` | `/dashboard/momentum` | `getMomentumPosts` | no |
| `GET` | `/dashboard/ai-insights?refresh=1` | `generateAiInsights` (DeepSeek) | `weeklyFocus` |
| `GET` | `/dashboard/comment-themes?refresh=1` | `generateCommentThemes` (DeepSeek) | `commentThemes` |
| `GET` | `/dashboard/caption-patterns?refresh=1` | `generateCaptionPatterns` (DeepSeek) | `captionPatterns` |
| `POST` | `/dashboard/sync-insights?backfill=1` | backfill + insight + snapshot sync | — |
| `POST` | `/dashboard/backfill?days=N` | `backfillFromPlatforms` | — |

Typed client methods: `dashboardKpis`, `dashboardTopPosts`, `dashboardHeatmap`, `dashboardTypeBreakdown`, `dashboardFollowerTrend`, `dashboardEngagementMix`, `dashboardSuperFans`, `dashboardMomentum`, `dashboardAiInsights(refresh)`, `dashboardCommentThemes(refresh)`, `dashboardCaptionPatterns(refresh)`, `dashboardSyncNow({backfill})` ([lib/api.ts](../apps/web/lib/api.ts)).

---

## 12. Cost notes (why the AI cards are manual-only)

The three DeepSeek cards are the only paid calls on this page, and they only fire when you click ↻ (or on the very first read for AI Insights). Each call stores its `inputTokens`/`outputTokens` in `DashboardAiCache` so the refresh tooltip can hint at the cost (~$0.0015/refresh range). Everything else is free Postgres aggregation. This is a deliberate cost decision — the same reason the project uses DeepSeek over Claude and dropped Redis.

---

## 13. Cold-start / empty states (what you'll see day 1)

- No posts yet → click **Sync now**; with <5 posts it auto-backfills 60 days of your real posts.
- Posts exist but no metrics → top performers/type breakdown show "no insights yet"; Sync now captures them on the decaying cadence.
- <2 follower snapshots → follower trend shows "give it 24–48h"; the followers KPI shows "tracking started …" with no delta.
- No comments yet → Comment Themes / Super-fans show empty states (and AI cards say so honestly rather than inventing patterns).

Every empty state tells you the exact next action — that's the design intent of the whole dashboard.
