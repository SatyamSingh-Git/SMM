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
  DAILY_REPLY_CAP,
} from "./reply-schedule.js";

// Polls Threads for new top-level comments on our recent posts. Uses Meta's
// `/{post_id}/replies` endpoint, which returns ONLY direct replies to the post
// (not the entire conversation tree). For each new top-level comment we
// haven't already ingested or that doesn't already have a reply, insert a
// queued EngagementComment + plan its reply fire-time.

// Look back this far when polling for posts. People sometimes comment on
// posts that are 1-2 weeks old (algorithm resurfaces them), so we go wider
// than the daily reply window — the reply runner enforces "same day" at
// send time, not the poller.
const LOOKBACK_DAYS = 14;
// Threads API max per page. Scan up to this many recent posts each poll so
// active accounts (posting many times a week) don't miss comments on the
// older-but-still-getting-replies posts. Bumped from 25 after observing the
// user posting ~44/week.
const POST_SCAN_LIMIT = 100;

export async function pollForNewComments(): Promise<{
  scanned: number;
  queued: number;
  skipped: number;
}> {
  let scanned = 0;
  let queued = 0;
  let skipped = 0;
  // Per-bucket counters for diagnostic visibility — printed at the end.
  let bucketOurOwn = 0;
  let bucketEmpty = 0;
  let bucketHasReplies = 0;
  let bucketExisting = 0;

  const account = await prisma.account.findFirst({
    where: { platform: "threads" },
  });
  if (!account) return { scanned, queued, skipped };

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
    return { scanned, queued, skipped };
  }

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
      // quiet window (00-06, 11-12, 14-16) if applicable. The polling reply
      // runner picks up queued comments once fireAt has passed AND the
      // current wall clock is outside a quiet window.
      const { fireAtMs } = planReplyTime();
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

  console.log(
    `[engage] poll: posts=${posts.length} ourReplyPosts=${bucketOurReplyPost} topLevel=${scanned} queued=${queued} skipped=${skipped} | drops: ours=${bucketOurOwn} empty=${bucketEmpty} hasReplies=${bucketHasReplies} existing=${bucketExisting}`
  );
  return { scanned, queued, skipped };
}
