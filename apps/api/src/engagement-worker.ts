// Postgres-polling engagement runner.
// Replaces BullMQ: polls for due replies every 90s (1 reply per tick, IST
// quiet-window aware), polls Threads for new comments every 5min, and runs
// style learning on boot + every 12h. Zero Redis commands.

import { prisma } from "@smm/db";
import { env } from "./env.js";
import { decryptToken } from "./crypto.js";
import { publishItem } from "./publishers/threads.js";
import { generateThreadsReply } from "./services/reply-generator.js";
import { pollForNewComments, pollHotPosts } from "./services/engagement.js";
import { learnThreadsStyle } from "./services/style-learning.js";
import { backfillFromPlatforms } from "./services/backfill.js";
import {
  isOverDailyCap,
  isOverPerPostCap,
  avoidQuietWindows,
  istDateKey,
  formatDynamicSleepWindowsToday,
} from "./services/reply-schedule.js";
import { getConfig } from "./services/runtime-config.js";

// Reply runner cadence. We deliberately go slower than Meta's published 1000
// replies/24h cap — what matters for anti-spam is the BURST rate, not the
// daily total. 90s ticks × 1 reply per tick = ~40 replies/hour ceiling. Real
// humans average more like 20-30/hour even when actively engaging, and we
// pause entirely during IST quiet windows.
const REPLY_POLL_MS = 90_000;
// Max replies fired per tick. Hard 1 to keep the cadence "1 reply every
// ~90s" instead of "5 replies in 10s then 80s idle."
const REPLY_BATCH_SIZE = 1;
// 8 minutes (was 5) — combined with LOOKBACK_DAYS=7 in services/engagement.ts,
// the comment poller's steady-state Threads-API budget drops from ~1,200/hr
// to ~300/hr, well under the 1,500/hr read cap (services/rate-limiter.ts).
const COMMENT_POLL_MS = 8 * 60_000;
// Hot-post burst: scan only brand-new posts (last ~45 min) every 60s so
// comments on fresh posts are DETECTED within ~1 min. The existing 5-20 min
// reply jitter is unchanged — this just gives that jitter room to land the
// reply inside the platform's first-30-min engagement-velocity window instead
// of after it. Cheap: usually 0-1 fresh posts per tick (see pollHotPosts).
const HOT_POLL_MS = 60_000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
// Periodic backfill of new posts from Meta so the dashboard sees content the
// user published directly via the Threads/Instagram apps (not through SMM's
// composer). 6 hours × a NARROW 2-day window keeps the per-cycle Meta cost
// small (1 listMyPosts + up to 8 paginated listMyMedia pages) while still
// catching new posts well before the user looks at the dashboard. The wider
// 14-day (or 60-day forced) window is reserved for the manual Sync button.
const AUTO_BACKFILL_MS = 6 * 60 * 60 * 1000;
const AUTO_BACKFILL_DAYS = 2;

let replyProcessing = false;

// --- Reply runner ---

async function processDueReplies(): Promise<void> {
  // Live auto-reply toggle (Settings). Off → don't fire any replies this tick.
  // The worker stays loaded; env ENGAGEMENT_ENABLED is still the hard boot gate.
  if (!getConfig().autoReplyEnabled) return;

  // Recover stuck "replying" comments (crashed mid-flight, >15 min stale).
  await prisma.engagementComment.updateMany({
    where: {
      status: "replying",
      updatedAt: { lt: new Date(Date.now() - 15 * 60_000) },
    },
    data: { status: "queued" },
  });

  // IST quiet windows (00-06, 11-12, 14-16): no replies fire at all.
  // We check the current clock, not the fireAt — so even if a fireAt was
  // assigned outside a window but the runner reaches it during one
  // (recovery stagger / clock drift), we still pause.
  const now = Date.now();
  if (avoidQuietWindows(now) > now) {
    return;
  }

  const dueComments = await prisma.engagementComment.findMany({
    where: {
      status: "queued",
      OR: [
        { fireAt: { lte: new Date() } },
        { fireAt: null },
      ],
    },
    orderBy: { fireAt: "asc" },
    take: REPLY_BATCH_SIZE,
    select: { id: true },
  });

  for (const { id } of dueComments) {
    await processOneReply(id);
  }
}

async function processOneReply(commentId: string): Promise<void> {
  if (getConfig().killSwitch) throw new Error("KILL_SWITCH on; refusing to reply");

  // Atomic claim: flip queued -> replying in a single conditional UPDATE so a
  // concurrent tick (or a second machine during a deploy) can't double-reply.
  const claim = await prisma.engagementComment.updateMany({
    where: { id: commentId, status: "queued" },
    data: { status: "replying" },
  });
  if (claim.count === 0) return;

  const comment = await prisma.engagementComment.findUnique({
    where: { id: commentId },
  });
  if (!comment) return;

  // SAME-DAY RULE (send-time guard): only reply on the SAME IST day the comment
  // was received. Catches anything that slipped to a later day — a backlog after
  // worker downtime, a boot-recovery re-queue, or a manual retry of an old
  // comment. No "ahead", no "backwards".
  if (istDateKey(Date.now()) !== istDateKey(comment.receivedAt.getTime())) {
    await prisma.engagementComment.update({
      where: { id: commentId },
      data: {
        status: "skipped",
        lastError: "outside same-day reply window (received on an earlier IST day)",
      },
    });
    console.log(`[engage] ⏭️ ${commentId} skipped (not same IST day)`);
    return;
  }

  try {
    // No time-based filtering: the agent replies to any queued comment
    // regardless of age. Persona-level skip rules (contact / explicit /
    // AI probe) still apply via the reply generator. The daily cap is the
    // only volume-control left.
    if (await isOverDailyCap()) {
      await prisma.engagementComment.update({
        where: { id: commentId },
        data: { status: "skipped", lastError: "daily cap reached at send time" },
      });
      console.log(`[engage] ⏭️ ${commentId} skipped (cap)`);
      return;
    }

    // Per-post cap re-check at send time (mirrors the daily-cap double-check).
    if (comment.platformPostId && (await isOverPerPostCap(comment.platformPostId))) {
      await prisma.engagementComment.update({
        where: { id: commentId },
        data: { status: "skipped", lastError: "per-post cap reached at send time" },
      });
      console.log(`[engage] ⏭️ ${commentId} skipped (per-post cap)`);
      return;
    }

    const account = await prisma.account.findFirst({
      where: { platform: "threads" },
    });
    if (!account) throw new Error("no threads account configured");
    const token = decryptToken(account.accessTokenEncrypted);

    const decision = await generateThreadsReply({
      postCaption: comment.postCaption,
      authorUsername: comment.authorUsername,
      commentText: comment.text,
    });

    if (!decision.shouldReply) {
      const reason = decision.reason ?? "agent declined";
      // Mechanical model failures (empty/unparseable JSON, empty reply text,
      // non-object output, the verbatim "model output not valid JSON") are
      // NOT deliberate skips — they're transient DeepSeek glitches. Re-queue
      // them with backoff instead of losing the comment permanently. We track
      // the retry count in lastError as a "[attempts=N] " prefix.
      const baseReason = reason.replace(/^\[attempts=\d+\]\s*/, "");
      const isMechanical =
        baseReason === "empty model output" ||
        baseReason === "model output not parseable" ||
        baseReason === "model output not valid JSON" ||
        baseReason === "empty reply text" ||
        baseReason === "non-object output";

      const prevAttempts = parseInt(
        (comment.lastError ?? "").match(/^\[attempts=(\d+)\]/)?.[1] ?? "0",
        10
      );
      const MAX_MECH_RETRIES = 3;

      if (isMechanical && prevAttempts < MAX_MECH_RETRIES) {
        // Backoff: 15min, 30min, 60min. Push past quiet windows so the
        // dashboard's "fires in N min" estimate matches reality and we don't
        // rely solely on the runner's wall-clock pause check.
        const backoffMin = 15 * Math.pow(2, prevAttempts);
        const fireAtMs = avoidQuietWindows(Date.now() + backoffMin * 60_000);
        await prisma.engagementComment.update({
          where: { id: commentId },
          data: {
            status: "queued",
            fireAt: new Date(fireAtMs),
            lastError: `[attempts=${prevAttempts + 1}] ${baseReason}`,
          },
        });
        console.log(
          `[engage] 🔄 ${commentId} mech-fail (${baseReason}) — requeue #${prevAttempts + 1} in ${backoffMin}min`
        );
        return;
      }

      // Terminal: a real persona decision OR mechanical failures exhausted
      // their retry budget. Suffix the exhausted-retries case so the boot
      // recovery below (which resurrects cutoff/mechanical skips) won't
      // re-pick this comment forever.
      const finalReason =
        isMechanical && prevAttempts >= MAX_MECH_RETRIES
          ? `${baseReason} (exhausted ${MAX_MECH_RETRIES} retries)`
          : baseReason;
      await prisma.engagementComment.update({
        where: { id: commentId },
        data: { status: "skipped", lastError: finalReason },
      });
      console.log(`[engage] ⏭️ ${commentId} skipped: ${finalReason}`);
      return;
    }

    // Safety gate: never post anything that looks like raw/broken JSON.
    if (/^\s*[{\[]/.test(decision.reply) || /["']?should_?[Rr]eply["']?\s*:/.test(decision.reply)) {
      await prisma.engagementComment.update({
        where: { id: commentId },
        data: {
          status: "failed",
          lastError: `reply looked like raw JSON — blocked: ${decision.reply.slice(0, 80)}`,
        },
      });
      console.error(`[engage] 🛑 ${commentId} blocked (JSON leak):`, decision.reply.slice(0, 80));
      return;
    }

    // Anti-spam guard: a tick can pass the top-of-processDueReplies clock
    // check at 06:59:50 and reach this point at 07:00:08 (after DB + DeepSeek)
    // — INSIDE a quiet window that started during processing. Re-check the
    // wall clock right before publish. If we crossed into a window, revert
    // the claim and re-queue with fireAt at the window end + jitter.
    const beforePublishNow = Date.now();
    const safeFireMs = avoidQuietWindows(beforePublishNow);
    if (safeFireMs > beforePublishNow) {
      await prisma.engagementComment.update({
        where: { id: commentId },
        data: {
          status: "queued",
          fireAt: new Date(safeFireMs),
        },
      });
      console.log(
        `[engage] ⏸️ ${commentId} re-queued — quiet window started during processing`
      );
      return;
    }

    // Send
    const published = await publishItem(account.platformUserId, token, {
      text: decision.reply,
      replyToId: comment.platformCommentId,
    });

    await prisma.engagementComment.update({
      where: { id: commentId },
      data: {
        status: "replied",
        agentReplyText: decision.reply,
        agentPlatformReplyId: published.id,
        lastError: null,
      },
    });
    console.log(`[engage] ✅ ${commentId} -> ${published.id}`);
  } catch (err) {
    const message = (err as Error).message;
    await prisma.engagementComment.update({
      where: { id: commentId },
      data: { status: "failed", lastError: message },
    });
    console.error(`[engage] ❌ ${commentId}:`, message);
  }
}

// --- One-shot boot cleanups ---

// Mark every queued comment whose `platformPostId` is one of our own past
// bot-replies as skipped. Those queue rows are leftover chain-escalation:
// people replying to our previous auto-replies that we wrongly ingested as
// "top-level comments" on R1/R2/... Once we deploy the new poller's
// ourReplyIds filter, no NEW chain rows get ingested — but the existing
// queue still has them, and the runner would happily fire them. This catches
// the backlog in one DB call at boot.
async function cleanupChainEscalationQueue(): Promise<void> {
  const ourReplyRows = await prisma.engagementComment.findMany({
    where: { agentPlatformReplyId: { not: null } },
    select: { agentPlatformReplyId: true },
  });
  const ourReplyIds = ourReplyRows
    .map((r) => r.agentPlatformReplyId)
    .filter((id): id is string => id !== null);
  if (ourReplyIds.length === 0) return;

  const r = await prisma.engagementComment.updateMany({
    where: {
      status: "queued",
      platformPostId: { in: ourReplyIds },
    },
    data: {
      status: "skipped",
      lastError:
        "chain escalation — comment is on one of our own previous replies, skipped to avoid loop",
    },
  });
  if (r.count > 0) {
    console.log(
      `[engage] cleanup: skipped ${r.count} queued chain-escalation comments`
    );
  }
}

// --- One-shot boot recovery ---

// Re-queue every comment that was skipped for a NON-persona reason: the
// (now-removed) resume cutoff, transient model failures, the (now-removed)
// "older than today" rule, or the bare "agent declined" fallback. Legit
// persona skips (contact / explicit / AI-probe / mild-suggestive that the
// model decided to ignore) are left alone — they reflect real decisions.
// Safe to re-run on every boot — comments that get re-skipped end up with an
// "(exhausted N retries)" suffix or a legitimate persona reason, neither of
// which matches the filter below.
async function recoverPreviouslySkipped(): Promise<void> {
  const rows = await prisma.engagementComment.findMany({
    where: {
      status: "skipped",
      OR: [
        { lastError: { startsWith: "predates resume cutoff" } },
        { lastError: { startsWith: "older than today" } },
        { lastError: { equals: "empty model output" } },
        { lastError: { equals: "model output not parseable" } },
        { lastError: { equals: "model output not valid JSON" } },
        { lastError: { equals: "empty reply text" } },
        { lastError: { equals: "non-object output" } },
        { lastError: { equals: "agent declined" } },
      ],
    },
    select: { id: true },
  });
  if (rows.length === 0) return;
  // Stagger fireAt across a long window so the recovery doesn't burst.
  // With ~40 replies/hour ceiling at the runner, spreading N comments over
  // max(2h, N/30 hours) keeps the rate well within human range. + random
  // sub-minute jitter so consecutive comments don't fire at the same offset.
  // Each fireAt is also pushed past any IST quiet window it lands inside,
  // so recovered comments never get scheduled into the no-reply hours.
  const SPREAD_HOURS = Math.max(2, Math.ceil(rows.length / 30));
  const SPREAD_MS = SPREAD_HOURS * 60 * 60_000;
  const now = Date.now();
  let i = 0;
  for (const row of rows) {
    const offsetMs =
      Math.floor((i / Math.max(rows.length, 1)) * SPREAD_MS) +
      Math.floor(Math.random() * 60_000);
    const desired = now + offsetMs;
    const fireAtMs = avoidQuietWindows(desired);
    await prisma.engagementComment.update({
      where: { id: row.id },
      data: {
        status: "queued",
        fireAt: new Date(fireAtMs),
        lastError: null,
      },
    });
    i++;
  }
  console.log(
    `[engage] recovery: re-queued ${rows.length} comments spread across ${SPREAD_HOURS}h (skipping IST quiet windows)`
  );
}

// --- Start all loops ---

// Reply runner — every 90s, 1 reply per tick, paused during IST quiet windows.
function replyTick(): void {
  if (replyProcessing) return;
  replyProcessing = true;
  processDueReplies()
    .catch((e) => console.error("[engage] reply poll error:", (e as Error).message))
    .finally(() => { replyProcessing = false; });
}

const replyPoll = setInterval(replyTick, REPLY_POLL_MS);
replyPoll.unref();

// Run once immediately (guarded by the same flag so it can't overlap the
// first interval tick).
replyTick();

// One-shot boot housekeeping (20s after boot):
//   1. Clean up queued chain-escalation comments — leftover rows on bot-reply
//      posts that would otherwise fire and continue the escalation loop.
//   2. Recover comments skipped for a NON-persona reason (cutoff / mechanical /
//      "older than today" / "agent declined"). Idempotent: re-skipped comments
//      get an "(exhausted N retries)" suffix or a persona reason, neither of
//      which matches the recovery filter.
const recoveryTimer = setTimeout(async () => {
  try {
    await cleanupChainEscalationQueue();
    await recoverPreviouslySkipped();
  } catch (e) {
    console.error("[engage] boot housekeeping failed:", (e as Error).message);
  }
}, 20_000);
recoveryTimer.unref();

// Comment poller — every 5 min (initial run 15s after boot).
const initialDelay = setTimeout(() => {
  pollForNewComments().catch((e) =>
    console.error("[engage] poll initial run error:", (e as Error).message)
  );
}, 15_000);
initialDelay.unref();

const commentPoll = setInterval(() => {
  pollForNewComments().catch((e) =>
    console.error("[engage] poll periodic error:", (e as Error).message)
  );
}, COMMENT_POLL_MS);
commentPoll.unref();

// Hot-post burst poller — every 60s, scans only the last ~45 min of posts.
// Guarded by a single-flight flag so a slow Meta call can't stack ticks.
let hotPollRunning = false;
const hotPoll = setInterval(() => {
  if (hotPollRunning) return;
  hotPollRunning = true;
  pollHotPosts()
    .catch((e) => console.error("[engage] hot poll error:", (e as Error).message))
    .finally(() => {
      hotPollRunning = false;
    });
}, HOT_POLL_MS);
hotPoll.unref();

// Style learning — on boot if needed + every 12h
const styleBootstrap = setTimeout(async () => {
  try {
    const have = await prisma.styleExample.count({ where: { platform: "threads" } });
    if (have < 20) {
      console.log("[engage] running initial style-learning (count=" + have + ")");
      const r = await learnThreadsStyle({ postLimit: 100 });
      console.log(
        `[engage] style-learning seeded: +${r.inserted} new, ${r.duplicates} dupes, ${r.scannedPosts} posts, ${r.skippedBotReplies} bot-replies skipped (feedback-loop guard)`
      );
    }
  } catch (e) {
    console.error("[engage] initial style-learning failed:", (e as Error).message);
  }
}, 45_000);
styleBootstrap.unref();

const styleRefresh = setInterval(() => {
  learnThreadsStyle({ postLimit: 30 })
    .then((r) =>
      console.log(
        `[engage] style-learning refresh: +${r.inserted} new, ${r.duplicates} dupes, ${r.skippedBotReplies} bot-replies skipped`
      )
    )
    .catch((e) =>
      console.error("[engage] style-learning refresh failed:", (e as Error).message)
    );
}, TWELVE_HOURS_MS);
styleRefresh.unref();

// Auto-backfill new posts from Meta — initial run 60s after boot, then every
// 6h. Catches posts the user published directly in the Threads/Instagram
// apps (without using the SMM composer) so the dashboard's KPIs, top-posts,
// heatmap, and follower trend stay accurate even when the user never clicks
// "Sync now". Concurrent runs are coalesced by the single-flight mutex
// inside backfillFromPlatforms.
//
// IMPORTANT: this auto-backfill DOES NOT regenerate the AI cards (Focus this
// week, Caption patterns, Comment themes). Those use DeepSeek tokens and are
// regenerated ONLY when the user clicks "Sync now" — the user's explicit
// choice to keep AI cost bounded by manual action. The dashboard's live SQL
// cards still update automatically; the cached AI cards stay until Sync.
function logBackfill(prefix: string, r: Awaited<ReturnType<typeof backfillFromPlatforms>>): void {
  const errPart = r.errors.length > 0 ? ` · errors: ${r.errors.length}` : "";
  console.log(
    `${prefix}: +${r.threadsCreated}/+${r.instagramCreated} new posts (scanned ${r.threadsScanned}/${r.instagramScanned})${errPart}`
  );
  for (const e of r.errors) console.log(`${prefix}   ! ${e}`);
}

const autoBackfillInitial = setTimeout(() => {
  backfillFromPlatforms({ daysBack: AUTO_BACKFILL_DAYS })
    .then((r) => logBackfill("[engage] initial auto-backfill", r))
    .catch((e) =>
      console.error("[engage] initial auto-backfill failed:", (e as Error).message)
    );
}, 60_000);
autoBackfillInitial.unref();

const autoBackfillInterval = setInterval(() => {
  backfillFromPlatforms({ daysBack: AUTO_BACKFILL_DAYS })
    .then((r) => logBackfill("[engage] auto-backfill", r))
    .catch((e) =>
      console.error("[engage] auto-backfill failed:", (e as Error).message)
    );
}, AUTO_BACKFILL_MS);
autoBackfillInterval.unref();

console.log(
  "[engage] runner ready (Postgres polling, 90s reply / 8min comments / 60s hot-post burst, IST quiet-window aware)"
);
console.log(
  `[engage] dynamic sleep windows today (IST): ${formatDynamicSleepWindowsToday()}`
);

process.on("SIGINT", () => {
  clearInterval(replyPoll);
  clearTimeout(initialDelay);
  clearInterval(commentPoll);
  clearInterval(hotPoll);
  clearTimeout(styleBootstrap);
  clearInterval(styleRefresh);
  clearTimeout(recoveryTimer);
  clearTimeout(autoBackfillInitial);
  clearInterval(autoBackfillInterval);
  process.exit(0);
});
