import { prisma } from "@smm/db";
import { decryptToken } from "../crypto.js";
import {
  fetchPostInsights as fetchIgPostInsights,
  fetchAccountSnapshot as fetchIgAccountSnapshot,
} from "../publishers/instagram.js";
import {
  fetchPostInsights as fetchThreadsPostInsights,
  fetchAccountSnapshot as fetchThreadsAccountSnapshot,
} from "../publishers/threads.js";

// Insights sync rules:
//   - For each published post, capture a fresh PostInsight row on a decaying
//     cadence: ~1h after publish, then ~6h, ~1d, ~3d, ~7d. After 7d we stop —
//     the numbers stabilize and continuing would just waste API calls.
//   - Once per day per account, capture an AccountSnapshot (follower count).
//
// We don't run a strict cron — we just look at "what posts need a fresh
// snapshot right now" each time the sync runs (every ~15 min from the worker)
// and capture whichever windows have elapsed since the last snapshot.

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

// Target capture intervals after publish. We capture if the most-recent snapshot
// is older than (interval - tolerance). Order matters — we pick the largest
// elapsed window that the post hasn't been snapshotted within.
const SNAPSHOT_WINDOWS_MS = [1 * ONE_HOUR, 6 * ONE_HOUR, 1 * ONE_DAY, 3 * ONE_DAY, 7 * ONE_DAY];

export async function syncPostInsights(opts?: {
  postLimit?: number;
}): Promise<{ scanned: number; captured: number; errors: number }> {
  const limit = opts?.postLimit ?? 50;
  const cutoff = new Date(Date.now() - 8 * ONE_DAY);
  let scanned = 0;
  let captured = 0;
  let errors = 0;

  const posts = await prisma.post.findMany({
    where: {
      status: "published",
      platformPostId: { not: null },
      // Only posts published within the last 8 days are worth re-syncing.
      updatedAt: { gte: cutoff },
    },
    include: {
      account: true,
      insights: { orderBy: { capturedAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  for (const post of posts) {
    scanned++;
    const lastSnap = post.insights[0];
    const sincePublish = Date.now() - new Date(post.updatedAt).getTime();
    const sinceSnap = lastSnap
      ? Date.now() - new Date(lastSnap.capturedAt).getTime()
      : Infinity;

    // Are we due? Find the smallest snapshot window that's elapsed since
    // publish AND it's been longer than that window since our last snapshot.
    const dueWindow = SNAPSHOT_WINDOWS_MS.find(
      (w) => sincePublish >= w && sinceSnap >= w
    );
    if (!dueWindow) continue;

    try {
      const token = decryptToken(post.account.accessTokenEncrypted);
      if (post.platform === "instagram" && post.platformPostId) {
        const m = await fetchIgPostInsights(post.platformPostId, token);
        await prisma.postInsight.create({
          data: {
            postId: post.id,
            reach: m.reach,
            impressions: m.impressions,
            views: m.views,
            likes: m.likes,
            comments: m.comments,
            saves: m.saves,
            shares: m.shares,
            profileVisits: m.profileVisits,
            follows: m.follows,
            rawJson: (m.raw ?? null) as never,
          },
        });
        captured++;
      } else if (post.platform === "threads" && post.platformPostId) {
        const m = await fetchThreadsPostInsights(post.platformPostId, token);
        await prisma.postInsight.create({
          data: {
            postId: post.id,
            views: m.views,
            likes: m.likes,
            comments: m.replies,
            shares: m.shares,
            reposts: m.reposts,
            quotes: m.quotes,
            rawJson: (m.raw ?? null) as never,
          },
        });
        captured++;
      }
    } catch (e) {
      errors++;
      console.error(
        `[insights] post ${post.id} sync failed:`,
        (e as Error).message
      );
    }
  }

  return { scanned, captured, errors };
}

export async function syncAccountSnapshots(): Promise<{
  captured: number;
  errors: number;
}> {
  let captured = 0;
  let errors = 0;
  const accounts = await prisma.account.findMany();
  const now = Date.now();

  for (const acc of accounts) {
    // Capture at most once per 20 hours per account (gives slack so a
    // ~daily sync schedule still always succeeds without dupes).
    const last = await prisma.accountSnapshot.findFirst({
      where: { accountId: acc.id },
      orderBy: { capturedAt: "desc" },
    });
    if (last && now - new Date(last.capturedAt).getTime() < 20 * ONE_HOUR) {
      continue;
    }

    try {
      const token = decryptToken(acc.accessTokenEncrypted);
      const snap =
        acc.platform === "instagram"
          ? await fetchIgAccountSnapshot(acc.platformUserId, token)
          : await fetchThreadsAccountSnapshot(acc.platformUserId, token);
      // Threads's snapshot is `{ followers }`; IG's is `{ followers, following?, postsCount? }`.
      const ig = snap as Partial<{ following: number; postsCount: number }>;
      await prisma.accountSnapshot.create({
        data: {
          accountId: acc.id,
          followers: snap.followers,
          following: ig.following,
          postsCount: ig.postsCount,
        },
      });
      captured++;
    } catch (e) {
      errors++;
      console.error(
        `[insights] account ${acc.id} snapshot failed:`,
        (e as Error).message
      );
    }
  }
  return { captured, errors };
}
