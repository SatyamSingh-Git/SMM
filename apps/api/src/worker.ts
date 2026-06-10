// Postgres-polling publish runner.
// Replaces BullMQ: every 30s, queries for posts due to publish and processes
// them one at a time. Zero Redis commands.

import { prisma } from "@smm/db";
import { env } from "./env.js";
import { decryptToken } from "./crypto.js";
import {
  publishItem as threadsPublishItem,
  publishChain,
  threadsPostUrl,
  type ThreadsItemSpec,
} from "./publishers/threads.js";
import {
  publishImage,
  publishReel,
  publishStory,
  publishCarousel,
} from "./publishers/instagram.js";
import { checkAndConsume, type LimiterKind } from "./services/rate-limiter.js";
import { startTokenRefreshLoop } from "./services/token-refresh.js";

const POLL_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 30_000; // 30s, 60s, 120s exponential

let processing = false;

function limiterKindFor(
  platform: "instagram" | "threads",
  type: string
): LimiterKind {
  if (platform === "threads") {
    return type === "threads_reply_chain" ? "threads_reply" : "threads_post";
  }
  if (type === "ig_carousel") return "instagram_carousel";
  return "instagram_total";
}

async function processDuePosts(): Promise<void> {
  // Recover stuck "publishing" posts (crashed mid-flight, >15 min stale).
  await prisma.post.updateMany({
    where: {
      status: "publishing",
      updatedAt: { lt: new Date(Date.now() - 15 * 60_000) },
    },
    data: { status: "queued" },
  });

  const duePosts = await prisma.post.findMany({
    where: {
      status: "queued",
      scheduledAt: { lte: new Date() },
    },
    orderBy: { scheduledAt: "asc" },
    take: 5,
    select: { id: true },
  });

  for (const { id } of duePosts) {
    await processOnePost(id);
  }
}

async function processOnePost(postId: string): Promise<void> {
  if (env.KILL_SWITCH) {
    console.log("[publish] KILL_SWITCH on, skipping", postId);
    return;
  }

  // Atomic claim: flip queued -> publishing in a single conditional UPDATE.
  // If another poll tick (or a second machine briefly overlapping during a
  // deploy) already claimed it, count is 0 and we bail — this is what prevents
  // double-publishing. Also covers the not-found and already-published cases
  // (neither matches status="queued", so neither gets claimed).
  const claim = await prisma.post.updateMany({
    where: { id: postId, status: "queued" },
    data: { status: "publishing" },
  });
  if (claim.count === 0) return;

  // Determine attempt number from previous PublishJob rows.
  const prevAttempts = await prisma.publishJob.count({ where: { postId } });
  const attempt = prevAttempts + 1;

  const jobRow = await prisma.publishJob.create({
    data: {
      postId,
      attempt,
      bullJobId: `pg-${attempt}`,
      startedAt: new Date(),
    },
  });

  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        assets: { include: { asset: true }, orderBy: { position: "asc" } },
        account: true,
      },
    });
    if (!post) throw new Error(`post ${postId} not found`);

    // Rate-limit check.
    const kind = limiterKindFor(post.platform, post.type);
    const gate = await checkAndConsume(post.account.id, kind);
    if (!gate.allowed) {
      const mins = Math.ceil(gate.retryAfterMs / 60_000);
      throw new Error(
        `rate limit hit for ${kind}: ${gate.current}/${gate.limit}. Retry in ~${mins}m.`
      );
    }

    const token = decryptToken(post.account.accessTokenEncrypted);
    let platformPostId: string;
    let platformUrl: string | undefined;

    const assetsWithMeta = post.assets.map((pa) => ({
      asset: pa.asset,
      altText: pa.altText ?? undefined,
      userTags:
        (pa.userTagsJson as
          | Array<{ username: string; x: number; y: number }>
          | null) ?? undefined,
    }));

    if (post.platform === "threads") {
      if (post.type === "threads_post") {
        const spec: ThreadsItemSpec = {};
        if (post.caption) spec.text = post.caption;
        if (assetsWithMeta.length === 1) {
          const a = assetsWithMeta[0]!;
          if (a.asset.mimeType.startsWith("video/")) spec.videoUrl = a.asset.publicUrl;
          else spec.imageUrl = a.asset.publicUrl;
          if (a.altText) spec.altText = a.altText;
        } else if (assetsWithMeta.length >= 2) {
          spec.carouselItems = assetsWithMeta.map((a) => ({
            ...(a.asset.mimeType.startsWith("video/")
              ? { videoUrl: a.asset.publicUrl }
              : { imageUrl: a.asset.publicUrl }),
            altText: a.altText,
          }));
        }
        const out = await threadsPublishItem(post.account.platformUserId, token, spec);
        platformPostId = out.id;
      } else if (post.type === "threads_reply_chain") {
        const chainData =
          (post.replyChainJson as Array<{ text?: string; assetIds?: string[] }> | null) ?? [];
        if (chainData.length === 0) throw new Error("reply chain is empty");
        const assetById = new Map<string, { publicUrl: string; mimeType: string; altText?: string }>();
        for (const a of assetsWithMeta) {
          assetById.set(a.asset.id, {
            publicUrl: a.asset.publicUrl,
            mimeType: a.asset.mimeType,
            altText: a.altText,
          });
        }
        const items: ThreadsItemSpec[] = chainData.map((c) => {
          const itemAssets = (c.assetIds ?? [])
            .map((id) => assetById.get(id))
            .filter((x): x is NonNullable<typeof x> => !!x);
          const spec: ThreadsItemSpec = {};
          if (c.text) spec.text = c.text;
          if (itemAssets.length === 1) {
            const a = itemAssets[0]!;
            if (a.mimeType.startsWith("video/")) spec.videoUrl = a.publicUrl;
            else spec.imageUrl = a.publicUrl;
            if (a.altText) spec.altText = a.altText;
          } else if (itemAssets.length >= 2) {
            spec.carouselItems = itemAssets.map((a) => ({
              ...(a.mimeType.startsWith("video/")
                ? { videoUrl: a.publicUrl }
                : { imageUrl: a.publicUrl }),
              altText: a.altText,
            }));
          }
          return spec;
        });
        const out = await publishChain(post.account.platformUserId, token, items);
        platformPostId = out.ids[0] ?? "";
      } else {
        throw new Error(`unsupported threads type: ${post.type}`);
      }
      if (post.account.username && platformPostId) {
        platformUrl = threadsPostUrl(post.account.username, platformPostId);
      }
    } else if (post.platform === "instagram") {
      const igExtras = (post.igExtrasJson ?? {}) as {
        locationId?: string;
        collaborators?: string[];
        thumbOffsetMs?: number;
        coverUrl?: string;
      };
      const commonExtras = {
        locationId: igExtras.locationId,
        collaborators: igExtras.collaborators,
      };

      if (post.type === "ig_feed") {
        const first = assetsWithMeta[0];
        if (!first) throw new Error("ig_feed requires an image asset");
        const out = await publishImage(post.account.platformUserId, token, {
          imageUrl: first.asset.publicUrl,
          caption: post.caption ?? undefined,
          altText: first.altText,
          userTags: first.userTags,
          extras: commonExtras,
        });
        platformPostId = out.id;
      } else if (post.type === "ig_reel") {
        const first = assetsWithMeta[0];
        if (!first) throw new Error("ig_reel requires a video asset");
        if (!first.asset.mimeType.startsWith("video/")) {
          throw new Error("ig_reel asset must be a video");
        }
        const out = await publishReel(post.account.platformUserId, token, {
          videoUrl: first.asset.publicUrl,
          caption: post.caption ?? undefined,
          shareToFeed: true,
          thumbOffsetMs: igExtras.thumbOffsetMs,
          coverUrl: igExtras.coverUrl,
          altText: first.altText,
          userTags: first.userTags,
          extras: commonExtras,
        });
        platformPostId = out.id;
      } else if (post.type === "ig_story") {
        const first = assetsWithMeta[0];
        if (!first) throw new Error("ig_story requires a media asset");
        const out = await publishStory(post.account.platformUserId, token, {
          mediaUrl: first.asset.publicUrl,
          mediaType: first.asset.mimeType.startsWith("video/") ? "video" : "image",
        });
        platformPostId = out.id;
      } else if (post.type === "ig_carousel") {
        if (assetsWithMeta.length < 2) {
          throw new Error("ig_carousel requires 2-10 assets");
        }
        const out = await publishCarousel(post.account.platformUserId, token, {
          items: assetsWithMeta.map((a) => ({
            url: a.asset.publicUrl,
            type: a.asset.mimeType.startsWith("video/") ? "video" : "image",
            altText: a.altText,
            userTags: a.userTags,
          })),
          caption: post.caption ?? undefined,
          extras: commonExtras,
        });
        platformPostId = out.id;
      } else {
        throw new Error(`unsupported instagram type: ${post.type}`);
      }
    } else {
      throw new Error(`unknown platform ${post.platform}`);
    }

    await prisma.post.update({
      where: { id: postId },
      data: {
        status: "published",
        publishedAt: new Date(),
        platformPostId,
        platformUrl: platformUrl ?? null,
        lastError: null,
      },
    });
    await prisma.publishJob.update({
      where: { id: jobRow.id },
      data: { finishedAt: new Date(), succeeded: true },
    });
    console.log(`[publish] ✅ ${postId} -> ${platformPostId}`);
  } catch (err) {
    const message = (err as Error).message;
    await prisma.publishJob.update({
      where: { id: jobRow.id },
      data: { finishedAt: new Date(), succeeded: false, errorMessage: message },
    });

    // Retry with exponential backoff, or give up after MAX_ATTEMPTS.
    if (attempt < MAX_ATTEMPTS) {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      await prisma.post.update({
        where: { id: postId },
        data: {
          status: "queued",
          scheduledAt: new Date(Date.now() + backoffMs),
          lastError: message,
        },
      });
      console.error(`[publish] ⚠️ ${postId} attempt ${attempt} failed, retry in ${backoffMs / 1000}s:`, message);
    } else {
      await prisma.post.update({
        where: { id: postId },
        data: { status: "failed", lastError: message },
      });
      console.error(`[publish] ❌ ${postId} failed after ${attempt} attempts:`, message);
    }
  }
}

// --- Start ---

function tick(): void {
  if (processing) return;
  processing = true;
  processDuePosts()
    .catch((e) => console.error("[publish] poll error:", (e as Error).message))
    .finally(() => { processing = false; });
}

const publishPoll = setInterval(tick, POLL_MS);
publishPoll.unref();

// Run once immediately on boot (guarded by the same flag, so the first
// interval tick can't overlap a slow boot poll).
tick();

// Token refresh runs inside the same process.
const tokenInterval = startTokenRefreshLoop();

console.log("[publish] runner ready (Postgres polling, 30s interval)");

process.on("SIGINT", () => {
  clearInterval(publishPoll);
  clearInterval(tokenInterval);
  process.exit(0);
});
