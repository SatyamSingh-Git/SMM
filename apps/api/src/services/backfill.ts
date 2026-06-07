import { prisma, type PostType } from "@smm/db";
import { decryptToken } from "../crypto.js";
import { listMyMedia } from "../publishers/instagram.js";
import { listMyPosts as listThreadsPosts } from "../publishers/threads.js";

// Seed the local Post table with the user's existing public posts on both
// platforms so the dashboard sees content the user published directly in the
// Threads/Instagram apps (not via the SMM composer).
//
// For each platform post:
//   - Skip if we already have a Post row with matching (accountId, platformPostId)
//   - Else create a Post row with status="published" + a synthetic MediaAsset
//     pointing at the platform's hosted media URL (used only for the
//     dashboard thumbnail — we don't try to re-publish it)
//
// CONCURRENCY: there are three callers that can fire backfillFromPlatforms in
// the same process — the /dashboard/sync-insights route, the worker's
// 60-second-after-boot initial run, and the worker's every-6h interval.
// Without coordination, two concurrent callers race on findFirst→create and
// produce DUPLICATE Post rows (the schema has no @@unique constraint on
// (accountId, platformPostId), only an index). The single-flight mutex below
// makes concurrent callers wait for the in-flight run and share its result.

const ONE_DAY = 24 * 60 * 60 * 1000;

export type BackfillResult = {
  threadsScanned: number;
  threadsCreated: number;
  instagramScanned: number;
  instagramCreated: number;
  // Per-platform error messages captured during this run. Empty when everything
  // went fine. The UI surfaces these so the user knows when (e.g.) the IG token
  // has expired — without this they'd see a silent "0 new posts" and be unable
  // to distinguish "nothing new" from "Meta rejected our calls".
  errors: string[];
};

// In-flight singleton. Concurrent callers await the same promise and get the
// same BackfillResult. Cleared after the in-flight run resolves/rejects so the
// next call starts a fresh run.
let backfillInFlight: Promise<BackfillResult> | null = null;

/**
 * Safe entrypoint. If a backfill is already running in this process, await
 * its result instead of starting a second concurrent run (which would race
 * on the findFirst→create dedupe and create duplicate Post rows).
 */
export async function backfillFromPlatforms(opts?: {
  daysBack?: number;
}): Promise<BackfillResult> {
  if (backfillInFlight) return backfillInFlight;
  backfillInFlight = (async () => {
    try {
      return await runBackfill(opts);
    } finally {
      backfillInFlight = null;
    }
  })();
  return backfillInFlight;
}

async function runBackfill(opts?: { daysBack?: number }): Promise<BackfillResult> {
  const days = opts?.daysBack ?? 60;
  const sinceMs = Date.now() - days * ONE_DAY;

  const result: BackfillResult = {
    threadsScanned: 0,
    threadsCreated: 0,
    instagramScanned: 0,
    instagramCreated: 0,
    errors: [],
  };

  const accounts = await prisma.account.findMany();
  for (const account of accounts) {
    const token = decryptToken(account.accessTokenEncrypted);
    if (account.platform === "threads") {
      const since = new Date(sinceMs);
      let posts;
      try {
        posts = await listThreadsPosts(account.platformUserId, token, {
          since,
          limit: 100,
        });
      } catch (e) {
        const msg = (e as Error).message;
        console.error("[backfill] threads listMyPosts failed:", msg);
        result.errors.push(`threads: ${msg.slice(0, 200)}`);
        continue;
      }
      result.threadsScanned += posts.length;
      for (const p of posts) {
        try {
          const ok = await upsertBackfilledPost({
            accountId: account.id,
            platform: "threads",
            type: "threads_post",
            platformPostId: p.id,
            platformUrl: p.permalink ?? null,
            caption: p.text ?? null,
            publishedAt: p.timestamp ? new Date(p.timestamp) : new Date(),
            mediaUrl: null,
            mediaType: null,
          });
          if (ok) result.threadsCreated++;
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`[backfill] threads upsert ${p.id} failed:`, msg);
          result.errors.push(`threads upsert: ${msg.slice(0, 200)}`);
        }
      }
    } else if (account.platform === "instagram") {
      let media;
      try {
        media = await listMyMedia(account.platformUserId, token, { sinceMs });
      } catch (e) {
        const msg = (e as Error).message;
        console.error("[backfill] instagram listMyMedia failed:", msg);
        result.errors.push(`instagram: ${msg.slice(0, 200)}`);
        continue;
      }
      result.instagramScanned += media.length;
      for (const m of media) {
        const type = igTypeFromMeta(m.mediaType, m.mediaProductType);
        try {
          const ok = await upsertBackfilledPost({
            accountId: account.id,
            platform: "instagram",
            type,
            platformPostId: m.id,
            platformUrl: m.permalink ?? null,
            caption: m.caption ?? null,
            publishedAt: new Date(m.timestamp),
            mediaUrl: m.mediaUrl ?? m.thumbnailUrl ?? null,
            mediaType: m.mediaType.toLowerCase().startsWith("video")
              ? "video"
              : "image",
          });
          if (ok) result.instagramCreated++;
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`[backfill] instagram upsert ${m.id} failed:`, msg);
          result.errors.push(`instagram upsert: ${msg.slice(0, 200)}`);
        }
      }
    }
  }
  return result;
}

function igTypeFromMeta(
  mediaType: string,
  productType: string | null
): PostType {
  if (productType === "REELS") return "ig_reel";
  if (productType === "STORY") return "ig_story";
  if (mediaType === "CAROUSEL_ALBUM") return "ig_carousel";
  return "ig_feed";
}

async function upsertBackfilledPost(args: {
  accountId: string;
  platform: "instagram" | "threads";
  type: PostType;
  platformPostId: string;
  platformUrl: string | null;
  caption: string | null;
  publishedAt: Date;
  mediaUrl: string | null;
  mediaType: "image" | "video" | null;
}): Promise<boolean> {
  // Dedupe — caller is now guaranteed not to be concurrent with another
  // backfill (via the single-flight mutex above), so this findFirst-then-
  // create is safe. A second backfill that fires after this one will see the
  // existing row and return false.
  const existing = await prisma.post.findFirst({
    where: {
      accountId: args.accountId,
      platformPostId: args.platformPostId,
    },
    select: { id: true },
  });
  if (existing) return false;

  // Synthetic MediaAsset pointing at the platform's hosted URL so the
  // dashboard top-performers grid has a thumbnail. This asset is read-only;
  // we never use it as image_url for new publishes. storageKey includes the
  // platform so threads/IG ids can't collide for the same accountId.
  const assetCreate = args.mediaUrl
    ? {
        assets: {
          create: [
            {
              position: 0,
              asset: {
                create: {
                  accountId: args.accountId,
                  type: args.mediaType ?? "image",
                  storageKey: `backfill:${args.platform}:${args.platformPostId}`,
                  publicUrl: args.mediaUrl,
                  mimeType:
                    args.mediaType === "video" ? "video/mp4" : "image/jpeg",
                  sizeBytes: 0,
                },
              },
            },
          ],
        },
      }
    : {};

  // Capture the create's return value so we can update its `updatedAt`
  // without a second findFirst — eliminating both a wasted DB round-trip
  // AND a second TOCTOU window where the override might land on the wrong
  // row if a duplicate slipped through.
  const created = await prisma.post.create({
    data: {
      accountId: args.accountId,
      platform: args.platform,
      type: args.type,
      caption: args.caption,
      status: "published",
      platformPostId: args.platformPostId,
      platformUrl: args.platformUrl,
      // scheduledAt = true publish time so heatmap/sorts behave.
      scheduledAt: args.publishedAt,
      ...assetCreate,
    },
    select: { id: true },
  });

  // Prisma's @updatedAt resets on every write, so even setting it explicitly
  // here is overwritten by the create. A follow-up update lets us pin
  // updatedAt to the real publish time — which the dashboard's "last 7d/30d"
  // filters all rely on.
  await prisma.post.update({
    where: { id: created.id },
    data: { updatedAt: args.publishedAt },
  });
  return true;
}

/**
 * True if the Post table is essentially empty (<5 published posts in the
 * last 60 days). Kept for any future caller that wants to gate behavior on
 * a cold-start. The /dashboard/sync-insights route no longer uses it — sync
 * always backfills now.
 */
export async function shouldAutoBackfill(): Promise<boolean> {
  const sinceMs = Date.now() - 60 * ONE_DAY;
  const count = await prisma.post.count({
    where: {
      status: "published",
      updatedAt: { gte: new Date(sinceMs) },
    },
  });
  return count < 5;
}
