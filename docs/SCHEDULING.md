# Scheduling & the Content Calendar (Stage 1)

Everything about composing, scheduling, and publishing posts to Instagram and Threads. This is the foundation the whole system is built on.

> **Scope of this doc:** the calendar page, the composer, media handling, AI caption assist, the publish runner, the Meta publisher adapters, the rate limiter, account/token lifecycle, and every related API endpoint. For analytics see [DASHBOARD.md](./DASHBOARD.md); for auto-reply see [AGENTS.md](./AGENTS.md).

---

## 1. The big picture — how a post is born and published

```
Composer (web)                 API                         Postgres            Meta
──────────────                 ───                         ────────            ────
upload media   ── POST /media ─────────────────────────►  MediaAsset row
                               returns {id, publicUrl}

click Schedule ─ POST /posts ──────────────────────────►  Post row
                               createPost()                 status=queued
                                                            scheduledAt=T

                               worker.ts polls every 30s
                               finds queued posts where
                               scheduledAt <= now    ────►  status=publishing
                               publishers/*.publish*  ─────────────────────►  create container
                                                                              poll until FINISHED
                                                                              publish container
                               on success            ────►  status=published
                                                            platformPostId, platformUrl
```

There is **no message queue.** Scheduling = writing a `Post` row with `status="queued"` and a `scheduledAt`. The publish runner ([apps/api/src/worker.ts](../apps/api/src/worker.ts)) polls Postgres every 30 seconds and publishes whatever is due. Changing a schedule = updating the row; cancelling = flipping status. The runner reads `scheduledAt` live, so nothing needs rescheduling.

---

## 2. Data model

All in [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma).

### `Account`
One row per connected platform identity (one IG, one Threads). Seeded automatically on API boot from the env tokens ([services/accounts.ts](../apps/api/src/services/accounts.ts) → `ensureAccountsFromEnv`).
- `platform` (`instagram` | `threads`), `platformUserId`, `username`
- `accessTokenEncrypted` — AES-256-GCM ciphertext ([crypto.ts](../apps/api/src/crypto.ts))
- `tokenExpiresAt` — used by the refresh loop
- unique on `(platform, platformUserId)`

### `MediaAsset`
An uploaded file. Created by `POST /media`.
- `type` (`image`|`video`), `storageKey`, `publicUrl`, `mimeType`, `sizeBytes`, optional `widthPx/heightPx/durationMs`
- `publicUrl` is what Meta fetches — it must be reachable HTTPS.

### `Post`
The unit of scheduling.
- `platform`, `type` (`PostType`), `caption`
- `scheduledAt` (UTC, null = draft), `status` (`PostStatus`)
- `platformPostId`, `platformUrl` (filled after publish)
- `aiGenerated` (bool — Meta AI-label flag for media)
- `replyChainJson` — ordered `[{text?, assetIds?}]` for Threads reply-chains
- `igExtrasJson` — `{locationId?, locationName?, collaborators?, thumbOffsetMs?, coverUrl?}`
- `lastError` — last failure message
- relations: `assets` (PostAsset[]), `publishJobs`, `insights`

### `PostAsset`
Join row (a post can have many ordered assets — carousels). Carries per-asset extras:
- `position` (0-indexed carousel order)
- `altText` (IG accessibility text)
- `userTagsJson` — `[{username, x, y}]`, x/y in `[0,1]` (IG in-image people tags)

### `PublishJob`
One row per publish **attempt** (audit + the runner's attempt counter). `attempt`, `startedAt`, `finishedAt`, `succeeded`, `errorMessage`, `bullJobId` (legacy field, now holds `pg-<attempt>`). Unique on `(postId, attempt)`.

### `PostStatus` lifecycle
```
draft ───(schedule)──► queued ──(runner claims)──► publishing ──► published
  ▲                      │                              │
  └──(edit, no date)─────┘                              ├──(retry < 3)──► queued (backoff)
                                                        └──(retry = 3)──► failed
queued/draft/failed ──(cancel)──► cancelled
```

---

## 3. Post types

Defined in the composer's `TYPE_CONFIG` ([components/compose-dialog.tsx](../apps/web/components/compose-dialog.tsx)) and the zod schema ([routes/posts.ts](../apps/api/src/routes/posts.ts)).

| `PostType` | Label | Media | Caption max | Notes |
|---|---|---|---|---|
| `ig_feed` | Feed Post | single image | 2200 | Single JPEG (any image is auto-converted to JPEG client-side). |
| `ig_reel` | Reel | single video | 2200 | MP4 H.264/AAC, 3–90s (duration validated client-side). Optional cover frame or custom cover image. |
| `ig_carousel` | Carousel | 2–10 images/videos | 2200 | Each child can have alt text + user tags. |
| `ig_story` | Story | single image or video | 0 (no caption) | Story video ≤60s. |
| `threads_post` | Post | 0–20 items (optional) | 500 | Text and/or single image/video or a 2–20 item carousel. |
| `threads_reply_chain` | Reply Chain | per-segment | 500/segment | Self-reply thread; each segment has its own text and/or media. |

Platform → allowed types: IG = feed/reel/carousel/story; Threads = post/reply-chain.

---

## 4. The Calendar page (`/`)

[apps/web/app/page.tsx](../apps/web/app/page.tsx) — the app's home. Layout: **Sidebar** | main **CalendarView** | **RightRail**.

- **Data loading:** `api.listAccounts()`, `api.health()`, and `api.listPosts({from, to})` for a window spanning last month → +2 months. Posts refetch every 15s (`refetchInterval: 15_000`).
- **PageHeader** shows connected accounts (`@user (platform) · …`) and the count of posts in view.
- **Legend** explains the color coding and the interactions.

### CalendarView ([components/calendar-view.tsx](../apps/web/components/calendar-view.tsx))
FullCalendar `dayGridMonth`, week starts Monday (`firstDay={1}`), max 3 events per day before "+more". Only posts with a `scheduledAt` become events. Each event (`CalendarEvent`) shows: platform icon (Camera/MessageCircle), the time (`h:mma`), a 28-char caption snippet, and a status icon (✓ published, ⚠ failed, spinner publishing). Color = danger (failed) / success (published) / platform color (instagram/threads).

Interactions:
- **Click a date** → open the composer pre-set to that date (`compose(date)`).
- **Click a post:** if `published` + has `platformUrl` → open the live post in a new tab. If `publishing` → ignored. Otherwise → open the composer in **edit** mode.

### RightRail ([components/right-rail.tsx](../apps/web/components/right-rail.tsx))
Three card stacks (each capped at 6, plus the engagement panel between them):
- **Drafts** — `status==="draft"`, newest first.
- **Upcoming** — `status==="queued"` with `scheduledAt` in the future, soonest first.
- **(Auto-replies panel)** — the engagement panel (see [AGENTS.md](./AGENTS.md)).
- **Recent** — published/failed/cancelled, newest first. Failed posts show their `lastError`.

Each row shows platform badge, type label, caption (2 lines), and a `PostActions` menu.

### PostActions ([components/post-actions.tsx](../apps/web/components/post-actions.tsx))
Per-post actions calling the API: **Edit** (opens composer), **Publish now** (`POST /posts/:id/publish-now`), **Retry** (`POST /posts/:id/retry`, failed posts), **Cancel/Delete** (`DELETE /posts/:id`).

---

## 5. The Composer ([components/compose-dialog.tsx](../apps/web/components/compose-dialog.tsx))

A two-pane modal: left = editor, right = live preview. Opens in **new** or **edit** mode (when a `Post` is passed). It is the single richest component in the app — here is everything it does.

### 5.1 Platform + type selection
- A Tabs control switches platform (Threads / Instagram); switching resets `type` to the platform's first allowed type.
- A pill row picks the specific type; each pill shows the type's icon + label.
- The dialog description shows the type's `hint` (e.g. "MP4 (H.264/AAC), ≤90s.").

### 5.2 Media upload
- Hidden `<input type=file>`; `accept` derives from the type (`image/*`, `video/mp4`, or both). `multi` types allow up to 10 (IG) selections.
- **Client-side JPEG conversion:** every non-JPEG image is converted to JPEG before upload via `ensureJpeg()` ([lib/image-convert.ts](../apps/web/lib/image-convert.ts)) — so Instagram (JPEG-only) always accepts it.
- **Client-side video duration check** (`probeVideoDurationSec`) against Meta specs before uploading: Reel 3–90s, Story ≤60s, Carousel video ≤60s. Out-of-range → upload aborted with a clear message (saves a wasted upload + failed publish).
- Upload calls `api.uploadMedia(file, accountId)` → `POST /media?accountId=…`. Thumbnails render in a grid; each can be removed. For IG, clicking a thumbnail opens the **AssetDetailDialog** to add **alt text** and **in-image user tags** ([components/asset-detail-dialog.tsx](../apps/web/components/asset-detail-dialog.tsx)).

### 5.3 Caption
- `<Textarea>` with `maxLength = cfg.captionMax`, a character counter, and an **emoji picker** ([components/emoji-picker-button.tsx](../apps/web/components/emoji-picker-button.tsx), inserts at cursor via [lib/insert-at-cursor.ts](../apps/web/lib/insert-at-cursor.ts)).
- **✨ AI suggest** button opens the AI caption dialog (§6).
- Stories (`captionMax: 0`) hide the caption field entirely.

### 5.4 Threads reply chain
When type is `threads_reply_chain`, a chain editor replaces the single caption. Each `ChainSegment`:
- Own text (≤500), own emoji picker, own media (up to 20 per segment, uploaded via `onChainPickFiles`).
- Numbered; removable down to a minimum of 2 segments; up to 20 segments.
- Validation: ≥2 segments must have text or media.

### 5.5 Instagram details (collapsible)
Only for IG. A `Settings2` panel ("Instagram details", shows a "customized" chip when any field is set):
- **Location** — `LocationPicker` ([components/location-picker.tsx](../apps/web/components/location-picker.tsx)) searches Meta Pages via `GET /locations/search?accountId&q`. Resolves to a `{id, name}` (the Facebook Page ID Meta uses for location tags).
- **Collaborators** — up to 5 IG usernames (chips; Enter/comma to add).
- **Reel cover** (reels only, `ReelCoverPanel`) — either a cover frame in seconds (`thumbOffsetMs`) or a custom cover image (uploaded + auto-JPEG'd, becomes `coverUrl`).
- **Mark as AI-generated** — sets `aiGenerated=true` on the post (internal flag + reminder to toggle "AI Info" in the IG app).

### 5.6 Schedule
- A `datetime-local` input + quick buttons: **Tonight 8pm**, **Tomorrow 9am**, **Next Mon 12pm**.
- The value is local time; converted to ISO UTC at submit.

### 5.7 The three submit modes
The footer has three buttons, all funneling through one mutation with `mode`:
- **Save draft** → `scheduledAt=null` → `status="draft"`. Never publishes.
- **Post now** → `scheduledAt = now()` → `status="queued"` → the runner picks it up within ~30s.
- **Schedule** → `scheduledAt = chosen time` → `status="queued"`. Disabled until a time is chosen.

Submit builds the payload: de-dupes all assets (single + chain) into `mediaAssetIds`; includes `assetMetas` only if any asset has alt/tags; includes `replyChain` for chains; includes `igExtras` only if non-empty. In **edit** mode it `PATCH`es (platform/account immutable); otherwise it `POST`s.

### 5.8 Validation (client-side, blocks submit)
Computed live: single-image needs 1 image; reel needs an MP4; carousel needs 2–10; caption ≤ max; chain needs ≥2 filled segments each ≤500; a Threads post needs text or media. The footer shows the current validation message or `Posting as @user · <type>`.

### 5.9 Live preview (right pane)
Renders an IG/Threads-ish card: avatar + username + "platform · type", location line, media grid (first 4), caption (or chain segments), collaborators line, and an "AI info" chip if flagged. Footer notes that media is served via `PUBLIC_BASE_URL` so Meta can fetch it.

---

## 6. AI caption assist ([components/compose-dialog.tsx](../apps/web/components/compose-dialog.tsx) `AiSuggestDialog`, [services/ai.ts](../apps/api/src/services/ai.ts))

`POST /ai/caption-suggest` → `suggestCaptions()`. Returns 1–5 `{caption, hashtags[]}` suggestions; tapping one applies it (hashtags appended for IG, dropped for Threads).

### Three modes (auto-selected, user-overridable)
- **fresh** — captions from scratch (optionally guided by an `intent` hint).
- **enhance** — rewrites the user's existing draft in the brand voice (needs ≥10 chars of draft).
- **from-image** — needs an uploaded image. **Two-step pipeline:**
  1. **OpenRouter / Qwen3-VL** (`OPENROUTER_VISION_MODEL`) describes the photo factually (outfit, pose, setting, lighting, mood) — vision only, no captioning.
  2. **DeepSeek** (`DEEPSEEK_MODEL`) writes the captions using that description + the brand voice. (DeepSeek's chat API can't take images — hence the split.)
  If vision fails, it falls back to blind generation.

### Controls
- **Language mix:** `english` (Gen-Z, no Hindi — default), `balanced` (light Hindi sprinkle), `hindi-heavy` (~40% roman Hindi).
- **Voice modifiers** (multi-select): cute, playful, flirty, bold, controversial(spicy), mysterious, soft, edgy, viral-bait. Default cute+playful.
- **Intent** free-text box ("mention monsoon, my new lipstick…").

The brand voice is a long persona system prompt for the creator (Gen-Z Indian female creator, audience young Indian men). It includes dozens of real style examples, strict emoji rules (4–6 per caption, lean on a heavy-rotation set, distribute don't stack), per-platform rules (IG ≤2200 + 8–15 hashtags; Threads ≤500 + no hashtags), and demands STRICT JSON output. Output is parsed (with fence-stripping fallback) and capped to the platform char limit.

DeepSeek call params: temperature 0.95, max_tokens 1500, JSON mode. Vision call: temperature 0.2, max_tokens 400.

---

## 7. Media pipeline ([routes/media.ts](../apps/api/src/routes/media.ts), [storage.ts](../apps/api/src/storage.ts))

- **`POST /media?accountId=…`** (multipart, 100 MB cap). Accepts `image/jpeg`, `image/png`, `video/mp4`. PNG is allowed but returns a **warning** that Instagram rejects PNG (Threads is fine). Saves the buffer to disk and creates a `MediaAsset`. Returns `{id, publicUrl, mimeType, warnings}`.
- **Storage driver** (local disk): writes to `UPLOAD_DIR` (default `apps/api/uploads`; `/data/uploads` on Fly). Filenames are `<uuid>.<ext>`. The public URL is `${PUBLIC_BASE_URL}/media/<key>`.
- **Serving:** `@fastify/static` serves `UPLOAD_DIR` at `/media/*`. **This is why `PUBLIC_BASE_URL` must be a public HTTPS URL** — Meta fetches `image_url`/`video_url` during container creation. In dev that's the Cloudflare Tunnel URL (the launcher rewrites `PUBLIC_BASE_URL` in `.env` on every start); in prod it's the Fly URL.

> Gotcha: a post created in local dev gets a `publicUrl` pointing at the *current* tunnel. If the tunnel changes (or you reference a `localhost` URL), Meta can't fetch it and the publish fails with "could not fetch media". Re-upload after the tunnel is live.

---

## 8. The publish runner ([apps/api/src/worker.ts](../apps/api/src/worker.ts))

A `setInterval` loop, **30s** (`POLL_MS`), guarded by a `processing` flag so ticks never overlap. Each tick (`processDuePosts`):

1. **Stuck recovery:** any post stuck in `publishing` for >15 min (crash mid-flight) is reset to `queued`.
2. **Find due:** up to 5 posts with `status="queued"` AND `scheduledAt <= now()`, oldest first.
3. **Process each** (`processOnePost`):
   - If `KILL_SWITCH` on → skip.
   - Compute `attempt` = count of existing `PublishJob` rows + 1.
   - Claim by setting `status="publishing"`, create a `PublishJob` row.
   - **Rate-limit check** (`checkAndConsume`, §10). If over → throw (becomes a retry).
   - Decrypt token, dispatch to the right publisher by platform+type (§9).
   - On success: `status="published"`, store `platformPostId` + `platformUrl`; mark the job succeeded.
   - On failure: mark the job failed with the message; if `attempt < 3` → back to `queued` with `scheduledAt = now + backoff` (exponential: 30s, 60s, 120s) and store `lastError`; if `attempt = 3` → `status="failed"`.

`MAX_ATTEMPTS = 3`, `BACKOFF_BASE_MS = 30_000`. The same process also starts the **token refresh loop** (§11).

Manual actions (in [services/posts.ts](../apps/api/src/services/posts.ts)):
- **`publishNow` / `retryPost`** delete prior `PublishJob` rows (resetting the attempt budget to a fresh 3), set `status="queued"`, `scheduledAt=now()`. The runner picks them up next tick.
- **`cancelPost`** sets `status="cancelled"` (the runner only ever picks up `queued`).
- **`updatePost`** updates the row; since the runner reads `scheduledAt` live there's no job to reschedule. Rejected for `published`/`publishing` posts.

---

## 9. Publisher adapters

Both follow Meta's two-step pattern: **create container → poll status until FINISHED → publish container**. Errors throw a typed `*ApiError` with the HTTP status + Meta body.

### Instagram ([publishers/instagram.ts](../apps/api/src/publishers/instagram.ts)) — `graph.instagram.com/v22.0`
- `publishImage` — single JPEG feed post. `image_url` + caption + extras → `/{user}/media` → poll → `/{user}/media_publish`.
- `publishReel` — `media_type=REELS`, `video_url`, `share_to_feed`, optional `thumb_offset`/`cover_url`. Polls up to **5 min** (video processing).
- `publishStory` — `media_type=STORIES`, image_url or video_url, no caption.
- `publishCarousel` — creates each child (`is_carousel_item=true`, videos polled), then a `CAROUSEL` parent referencing the children, then publishes. Enforces 2–10 items.
- **Extras** (`applyExtras`): `alt_text`, `user_tags` (JSON `[{username,x,y}]`), `location_id`, `collaborators` (JSON, @-stripped). Children get alt/tags only; location/collaborators go on the parent.
- Reads: `getMe`, `listMyMedia` (paginated backfill), `fetchPostInsights`, `fetchAccountSnapshot` (followers/following/media counts).

### Threads ([publishers/threads.ts](../apps/api/src/publishers/threads.ts)) — `graph.threads.net/v1.0`
- `publishItem(spec)` — handles `TEXT` / `IMAGE` / `VIDEO` / `CAROUSEL` (auto-detected from the `ThreadsItemSpec`). Carousel: create each child → wait → parent (2–20 items). Supports `reply_to_id` (this is how replies and chains attach).
- `publishChain(items)` — posts the first item, then replies each subsequent item to the previous (`reply_to_id = previous id`). Used for `threads_reply_chain`.
- `publishText` — convenience wrapper used by `/test/threads`.
- `threadsPostUrl(username, id)` builds the public URL.
- Reads (used by Stage 2 + insights): `getMe`, `listMyPosts`, `fetchConversation` (full reply tree), `fetchPostInsights` (views/likes/replies/reposts/quotes/shares), `fetchAccountSnapshot` (followers).

`ThreadsItemSpec`: `{ text?, imageUrl?, videoUrl?, altText?, carouselItems?[], replyToId? }`.

### Dispatch (in worker.ts)
`threads_post` → `publishItem` (text / single media / carousel from the post's assets). `threads_reply_chain` → builds `ThreadsItemSpec[]` from `replyChainJson` (resolving each segment's `assetIds`) → `publishChain`. `ig_feed/reel/story/carousel` → the matching IG function, reading `igExtrasJson` for location/collaborators/cover.

---

## 10. Rate limiter ([services/rate-limiter.ts](../apps/api/src/services/rate-limiter.ts))

In-memory sliding window (no Redis — safe because one process runs on Fly). `checkAndConsume(accountId, kind)` prunes the 24h window and either consumes a slot or returns `{allowed:false, retryAfterMs,…}` (which the runner turns into a retry). Caps (20% under Meta's real limits):

| kind | cap / 24h | Meta's actual |
|---|---|---|
| `instagram_total` | 80 | 100 |
| `instagram_carousel` | 40 | 50 |
| `threads_post` | 200 | 250 |
| `threads_reply` | 800 | 1000 |

`limiterKindFor(platform, type)` maps a post to its kind (IG carousels count against both the carousel and total budgets conceptually; the worker picks `instagram_carousel` for carousels, `instagram_total` otherwise). On restart the window resets — the safety margin absorbs it. `usage()` exposes current counts (for a future widget).

---

## 11. Accounts & tokens

- **Seeding** ([services/accounts.ts](../apps/api/src/services/accounts.ts)): on boot, `ensureAccountsFromEnv()` calls `getMe` for each env token, then upserts an `Account` (encrypting the token, setting a conservative 60-day initial expiry without clobbering a real one already learned).
- **Refresh** ([services/token-refresh.ts](../apps/api/src/services/token-refresh.ts)): a loop inside the publish runner refreshes any token with ≤7 days left (or unknown expiry) — IG via `graph.instagram.com/refresh_access_token`, Threads via `graph.threads.net/refresh_access_token`. Runs 30s after boot, then every 6h.
- **`GET /accounts`** lists connected accounts (`listAccounts`).

---

## 12. Scheduling-related API reference

All under [routes/posts.ts](../apps/api/src/routes/posts.ts) unless noted. Bodies are zod-validated; failures return 400 with the flattened error.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/posts` | Create a post. Body: `accountId, platform, type, caption?, mediaAssetIds[], assetMetas?[], replyChain?[], igExtras?, scheduledAt?`. `scheduledAt` null = draft, past = queue now. |
| `GET` | `/posts?status&platform&from&to` | List posts (max 500), ordered by `scheduledAt` then `createdAt`. |
| `GET` | `/posts/:id` | One post with assets. |
| `PATCH` | `/posts/:id` | Update (draft/queued/failed only). All fields optional; account/platform immutable. |
| `DELETE` | `/posts/:id` | Cancel (sets `status="cancelled"`). |
| `POST` | `/posts/:id/publish-now` | Queue for immediate publish (fresh attempt budget). |
| `POST` | `/posts/:id/retry` | Re-queue a failed post (fresh attempt budget). |
| `POST` | `/media?accountId=` | Upload one file → `MediaAsset`. ([routes/media.ts](../apps/api/src/routes/media.ts)) |
| `GET` | `/media/<key>` | Serve an uploaded file (static). |
| `POST` | `/ai/caption-suggest` | AI caption suggestions. ([routes/ai.ts](../apps/api/src/routes/ai.ts)) |
| `GET` | `/locations/search?accountId&q` | Meta Pages location search (IG). ([routes/locations.ts](../apps/api/src/routes/locations.ts)) |
| `GET` | `/accounts` | List connected accounts. |
| `GET` | `/health` | Liveness + `killSwitch` + env. |
| `GET/POST` | `/test/*` | Manual pipeline checks (`/test/whoami`, `/test/threads`, `/test/instagram`) — bypass DB/queue, post directly with env tokens. ([routes/test.ts](../apps/api/src/routes/test.ts)) |

The typed client wrapping all of these is [apps/web/lib/api.ts](../apps/web/lib/api.ts).

---

## 13. Failure modes & how they surface

| Symptom | Cause | Where you see it |
|---|---|---|
| Post stuck `failed`, error "could not fetch media" / `localhost` URL | media `publicUrl` not reachable by Meta (tunnel down / stale) | RightRail "Recent" card + `lastError`; re-upload + retry |
| Reel `failed` after long wait | video processing errored or exceeded poll window | `lastError`; check codec/duration |
| Carousel rejected | <2 or >10 items, or a child failed processing | composer blocks <2; Meta error otherwise |
| Publish silently not firing | `KILL_SWITCH=true`, or post is `draft` (no `scheduledAt`), or runner not running | `/health` shows killSwitch; check the post status |
| Rate-limit retries | hit the 24h cap | `lastError` "rate limit hit …"; auto-retries with backoff |
| IG PNG fails | Instagram only accepts JPEG | upload warning; composer auto-converts to avoid this |

**Kill switch:** `KILL_SWITCH=true` makes the runner skip every post (and the `/test/*` routes 503). Flip it off and queued posts resume on the next tick.
