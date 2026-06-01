import { prisma, type PostType } from "@smm/db";
import { decryptToken } from "../crypto.js";
import { listMyMedia } from "../publishers/instagram.js";
import { listMyPosts as listThreadsPosts } from "../publishers/threads.js";

// Seed the local Post table with the user's existing public posts on both
// platforms so the dashboard has data on day 1 instead of starting empty.
//
// For each platform post:
//   - Skip if we already have a Post row with matching platformPostId
//   - Else create a Post row with status="published" + a synthetic MediaAsset
//     pointing at the platform's hosted media URL (used only for the
//     dashboard thumbnail — we don't try to re-publish it)
//
// The user typically runs this once from the dashboard "Sync now" button;
// the sync orchestrator below calls it automatically if the Post table is
// nearly empty.

const ONE_DAY = 24 * 60 * 60 * 1000;

export type BackfillResult = {
  threadsScanned: number;
  threadsCreated: number;
  instagramScanned: number;
  instagramCreated: number;
};

export async function backfillFromPlatforms(opts?: {
  daysBack?: number;
}): Promise<BackfillResult> {
  const days = opts?.daysBack ?? 60;
  const sinceMs = Date.now() - days * ONE_DAY;

  const result: BackfillResult = {
    threadsScanned: 0,
    threadsCreated: 0,
    instagramScanned: 0,
    instagramCreated: 0,
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
        console.error(
          "[backfill] threads listMyPosts failed:",
          (e as Error).message
        );
        continue;
      }
      result.threadsScanned += posts.length;
      for (const p of posts) {
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
      }
    } else if (account.platform === "instagram") {
      let media;
      try {
        media = await listMyMedia(account.platformUserId, token, { sinceMs });
      } catch (e) {
        console.error(
          "[backfill] instagram listMyMedia failed:",
          (e as Error).message
        );
        continue;
      }
      result.instagramScanned += media.length;
      for (const m of media) {
        const type = igTypeFromMeta(m.mediaType, m.mediaProductType);
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
  const existing = await prisma.post.findFirst({
    where: {
      accountId: args.accountId,
      platformPostId: args.platformPostId,
    },
  });
  if (existing) return false;

  // We synthesize a MediaAsset pointing at the platform's hosted URL so the
  // dashboard top-performers grid has a thumbnail. This asset is read-only;
  // we never use it as image_url for new publishes.
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
                  storageKey: `backfill:${args.platformPostId}`,
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

  await prisma.post.create({
    data: {
      accountId: args.accountId,
      platform: args.platform,
      type: args.type,
      caption: args.caption,
      status: "published",
      platformPostId: args.platformPostId,
      platformUrl: args.platformUrl,
      // We set both scheduledAt and updatedAt to the true publish time so all
      // dashboard time-based queries (last 30d, heatmap, etc.) work correctly
      // for backfilled posts.
      scheduledAt: args.publishedAt,
      ...assetCreate,
    },
  });

  // Prisma doesn't let us set `updatedAt` directly on create (it's @updatedAt).
  // We override it with a raw update so dashboard "last 30 days" filters work.
  const justCreated = await prisma.post.findFirst({
    where: { platformPostId: args.platformPostId, accountId: args.accountId },
  });
  if (justCreated) {
    await prisma.post.update({
      where: { id: justCreated.id },
      data: { updatedAt: args.publishedAt },
    });
  }
  return true;
}

/**
 * True if the Post table is essentially empty (<5 published posts in the
 * last 60 days). The sync orchestrator uses this to decide whether to run
 * a backfill before fetching insights.
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
