import { prisma } from "@smm/db";
import { decryptToken } from "../crypto.js";
import {
  fetchReplies,
  listMyPosts,
  type ThreadsConversationNode,
} from "../publishers/threads.js";
import {
  planReplyTime,
  isOverDailyCap,
  istDateKey,
  DAILY_REPLY_CAP,
} from "./reply-schedule.js";

// Polls Threads for new top-level comments on our recent posts. Uses Meta's
// `/{post_id}/replies` endpoint, which returns ONLY direct replies to the post
// (not the entire conversation tree). For each new top-level comment we
// haven't already ingested or that doesn't already have a reply, insert a
// queued EngagementComment + plan its reply fire-time.

// Look back this far when polling for posts. People comment on older posts
// sometimes (algorithm resurfaces), but each extra day adds N=posts-per-day
// fetchReplies calls per cycle — and at the user's posting cadence the 14-day
// window was driving Meta-read traffic at ~1,200/hr per the read-side limiter
// audit. 7 days covers the dashboard-relevant window AND drops steady-state
// load by half. Older-but-still-getting-comments posts are handled by the
// Sync button (which explicitly backfills 14d / 60d).
const LOOKBACK_DAYS = 7;
// Threads API max per page. Scan up to this many recent posts each poll so
// active accounts (posting many times a week) don't miss comments on the
// older-but-still-getting-replies posts. Bumped from 25 after observing the
// user posting ~44/week.
const POST_SCAN_LIMIT = 100;

// --- Hot-post burst window (faster detection on brand-new posts) ---
// Instagram/Threads reward fast engagement in a post's first ~30 min. The main
// poller (every 8 min, 7-day window) detects comments within minutes, which —
// added to the 5-20 min reply jitter — can push a reply just past the 30-min
// window. The hot poller scans ONLY very-recent posts every 60s so comments on
// fresh posts are detected within ~1 min, leaving the SAME human-like jitter
// room to land the reply inside the window. It does NOT speed up replies; it
// speeds up DETECTION. Cost is tiny: at ~4 posts/day there are usually 0-1
// posts in a 45-min window, so a hot tick is ~1 listMyPosts + 0-1 fetchReplies.
const HOT_WINDOW_MS = 45 * 60_000;
const HOT_SCAN_LIMIT = 25;

// Account fields the scanner needs (kept narrow so both callers can pass a
// findFirst row without coupling to the full Prisma model).
type ScanAccount = { username: string | null };

export async function pollForNewComments(): Promise<{
  scanned: number;
  queued: number;
  skipped: number;
}> {
  const account = await prisma.account.findFirst({
    where: { platform: "threads" },
  });
  if (!account) return { scanned: 0, queued: 0, skipped: 0 };

  const token = decryptToken(account.accessTokenEncrypted);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000);

  let posts;
  try {
    posts = await listMyPosts(account.platformUserId, token, {
      since,
      limit: POST_SCAN_LIMIT,
    });
  } catch (e) {
    console.error("[engagement] listMyPosts failed:", (e as Error).message);
    return { scanned: 0, queued: 0, skipped: 0 };
  }

  return scanPostsForComments(posts, token, account, "poll");
}

// Hot-post burst: detect comments on brand-new posts within ~1 min. Same
// dedup / daily-cap / reply-jitter as the main poll — only the post window and
// cadence differ. Lists posts from the last HOT_WINDOW_MS and scans their
// replies. Returns early (no fetchReplies) when there are no fresh posts.
export async function pollHotPosts(): Promise<{
  scanned: number;
  queued: number;
  skipped: number;
}> {
  const account = await prisma.account.findFirst({
    where: { platform: "threads" },
  });
  if (!account) return { scanned: 0, queued: 0, skipped: 0 };

  const token = decryptToken(account.accessTokenEncrypted);
  const since = new Date(Date.now() - HOT_WINDOW_MS);

  let posts;
  try {
    posts = await listMyPosts(account.platformUserId, token, {
      since,
      limit: HOT_SCAN_LIMIT,
    });
  } catch (e) {
    console.error("[engagement] hot listMyPosts failed:", (e as Error).message);
    return { scanned: 0, queued: 0, skipped: 0 };
  }
  if (posts.length === 0) return { scanned: 0, queued: 0, skipped: 0 };

  return scanPostsForComments(posts, token, account, "hot");
}

// Shared scan: dedup + queue new top-level comments across a set of posts.
// Behavior is identical for both callers — only the input post set differs.
async function scanPostsForComments(
  posts: Array<{ id: string; text?: string | null }>,
  token: string,
  account: ScanAccount,
  label: "poll" | "hot"
): Promise<{ scanned: number; queued: number; skipped: number }> {
  let scanned = 0;
  let queued = 0;
  let skipped = 0;
  // Per-bucket counters for diagnostic visibility — printed at the end.
  let bucketOurOwn = 0;
  let bucketEmpty = 0;
  let bucketHasReplies = 0;
  let bucketExisting = 0;

  let dumpedShape = false;
  const ourUsername = account.username?.toLowerCase() ?? "";

  // Pre-fetch every Threads post id that was created by the agent (our own
  // bot replies). They show up in listMyPosts because they're posted under
  // the user's account, but if we scan THEIR replies we end up replying to
  // anyone who responds to our reply → chain escalation. Skip them.
  const ourReplyRows = await prisma.engagementComment.findMany({
    where: { agentPlatformReplyId: { not: null } },
    select: { agentPlatformReplyId: true },
  });
  const ourReplyIds = new Set(
    ourReplyRows
      .map((r) => r.agentPlatformReplyId)
      .filter((id): id is string => id !== null)
  );
  let bucketOurReplyPost = 0;

  for (const post of posts) {
    if (ourReplyIds.has(post.id)) {
      // This `post` is actually one of our previous auto-replies. Don't
      // scan its replies — that's how chain escalation starts.
      bucketOurReplyPost++;
      continue;
    }
    let nodes: ThreadsConversationNode[];
    try {
      // /replies returns ONLY top-level direct replies to the post — exactly
      // what we want. No tree-walking, no filtering by replied_to.id needed.
      nodes = await fetchReplies(post.id, token);
    } catch (e) {
      console.error(
        `[engagement] fetchReplies ${post.id} failed:`,
        (e as Error).message
      );
      continue;
    }
    scanned += nodes.length;

    // One-shot per poll: dump the first non-empty post's first 2 nodes so we
    // can verify the actual response shape from /replies. Remove once stable.
    if (!dumpedShape && nodes.length > 0) {
      console.log(
        `[engage] sample post=${post.id} replyCount=${nodes.length} firstTwo=${JSON.stringify(nodes.slice(0, 2))}`
      );
      dumpedShape = true;
    }

    for (const tlc of nodes) {
      // Author is the top-level `username` field on the node (per Meta docs).
      // We accept `from.username` as a defensive fallback for legacy shapes.
      const authorUsername = (tlc.username ?? tlc.from?.username ?? "").toLowerCase();
      if (
        authorUsername !== "" &&
        ourUsername !== "" &&
        authorUsername === ourUsername
      ) {
        bucketOurOwn++;
        continue;
      }
      if (!tlc.text || tlc.text.trim().length === 0) {
        bucketEmpty++;
        continue;
      }

      // Dedupe: have we already ingested this comment?
      const existing = await prisma.engagementComment.findUnique({
        where: { platformCommentId: tlc.id },
      });

      // `has_replies=true` means SOMETHING is under this comment already —
      // could be us from a previous run, the user replying manually, or a
      // third-party. Either way, don't double-reply. We skip but still
      // record the comment (if new) so it's visible in the dashboard.
      if (tlc.has_replies === true && !existing) {
        await prisma.engagementComment.create({
          data: {
            platform: "threads",
            platformCommentId: tlc.id,
            platformPostId: post.id,
            postCaption: post.text ?? null,
            parentPlatformId: post.id,
            authorUsername: tlc.username ?? tlc.from?.username ?? null,
            authorPlatformId: tlc.from?.id ?? null,
            text: tlc.text,
            status: "skipped",
            lastError: "thread already has a reply — left for manual handling",
          },
        });
        bucketHasReplies++;
        skipped++;
        continue;
      }

      if (existing) {
        // Already queued / replied / skipped / failed — no action needed.
        bucketExisting++;
        continue;
      }

      // Hard daily cap. If we've already committed to 300 replies today
      // (queued + replying + replied), record this comment as skipped so
      // the user sees it in the UI and can choose to reply manually.
      if (await isOverDailyCap()) {
        await prisma.engagementComment.create({
          data: {
            platform: "threads",
            platformCommentId: tlc.id,
            platformPostId: post.id,
            postCaption: post.text ?? null,
            parentPlatformId: post.id,
            authorUsername: tlc.username ?? tlc.from?.username ?? null,
            authorPlatformId: tlc.from?.id ?? null,
            text: tlc.text,
            status: "skipped",
            lastError: `daily cap of ${DAILY_REPLY_CAP} reached`,
          },
        });
        skipped++;
        continue;
      }

      // Plan the fire time: 5-20 min random delay, then push past any IST
      // quiet window (23-06, 11-12, 14-16) if applicable. The polling reply
      // runner picks up queued comments once fireAt has passed AND the
      // current wall clock is outside a quiet window.
      const nowMs = Date.now();
      const { fireAtMs } = planReplyTime(nowMs);

      // SAME-DAY RULE: a comment received on an IST day is only ever replied on
      // that same IST day. If the planned fire time spills into the next IST day
      // (e.g. a late-night comment pushed past the 23:00 overnight window), we
      // drop it rather than reply tomorrow. No "ahead", no "backwards".
      if (istDateKey(fireAtMs) !== istDateKey(nowMs)) {
        await prisma.engagementComment.create({
          data: {
            platform: "threads",
            platformCommentId: tlc.id,
            platformPostId: post.id,
            postCaption: post.text ?? null,
            parentPlatformId: post.id,
            authorUsername: tlc.username ?? tlc.from?.username ?? null,
            authorPlatformId: tlc.from?.id ?? null,
            text: tlc.text,
            status: "skipped",
            lastError: "outside same-day reply window (would reply next IST day)",
          },
        });
        skipped++;
        continue;
      }

      await prisma.engagementComment.create({
        data: {
          platform: "threads",
          platformCommentId: tlc.id,
          platformPostId: post.id,
          postCaption: post.text ?? null,
          parentPlatformId: post.id,
          authorUsername: tlc.username ?? tlc.from?.username ?? null,
          authorPlatformId: tlc.from?.id ?? null,
          text: tlc.text,
          status: "queued",
          fireAt: new Date(fireAtMs),
        },
      });
      queued++;
    }
  }

  // Hot ticks are frequent and usually no-ops; only log them when they
  // actually did something, to avoid spamming the logs once a minute.
  if (label !== "hot" || queued > 0 || skipped > 0) {
    console.log(
      `[engage] ${label}: posts=${posts.length} ourReplyPosts=${bucketOurReplyPost} topLevel=${scanned} queued=${queued} skipped=${skipped} | drops: ours=${bucketOurOwn} empty=${bucketEmpty} hasReplies=${bucketHasReplies} existing=${bucketExisting}`
    );
  }
  return { scanned, queued, skipped };
}
