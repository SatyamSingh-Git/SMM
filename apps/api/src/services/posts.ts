import { prisma, type Platform, type PostType, type PostStatus } from "@smm/db";
import { suggestCaptions } from "./ai.js";
import { validatePost, type PostType as RulePostType } from "@smm/shared";

export type IgPostExtras = {
  locationId?: string;
  locationName?: string;
  collaborators?: string[];
  thumbOffsetMs?: number; // Reels only
  coverUrl?: string; // Reels only
  isAiGenerated?: boolean; // we set post.aiGenerated + remind user to flip IG-app toggle
};

export type AssetMeta = {
  assetId: string;
  altText?: string;
  userTags?: Array<{ username: string; x: number; y: number }>;
};

export type CreatePostInput = {
  accountId: string;
  platform: Platform;
  type: PostType;
  caption?: string;
  // Either mediaAssetIds (simple) OR assetMetas (with per-asset alt/tags).
  // If both, assetMetas wins.
  mediaAssetIds: string[];
  assetMetas?: AssetMeta[];
  // For threads_reply_chain: ordered list of segments to post as a self-reply chain.
  // Each segment can carry its own text and/or media (referenced by MediaAsset.id;
  // those assets are uploaded with the same accountId and listed in mediaAssetIds).
  replyChain?: Array<{ text?: string; assetIds?: string[] }>;
  // IG container-level extras (location/collaborators/reel cover/AI flag).
  igExtras?: IgPostExtras;
  // Threads-only: single topic tag for niche discovery.
  topicTag?: string | null;
  // ISO string; if missing => draft. If past => queue immediately.
  scheduledAt?: string | null;
};

export async function createPost(input: CreatePostInput) {
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  const status: PostStatus = scheduledAt ? "queued" : "draft";

  // Build the assets list: prefer assetMetas if provided (carries alt + tags).
  const assetSpecs: AssetMeta[] = input.assetMetas?.length
    ? input.assetMetas
    : input.mediaAssetIds.map((assetId) => ({ assetId }));

  const post = await prisma.post.create({
    data: {
      accountId: input.accountId,
      platform: input.platform,
      type: input.type,
      caption: input.caption ?? null,
      scheduledAt,
      status,
      topicTag: input.topicTag?.trim() ? input.topicTag.trim() : null,
      aiGenerated: input.igExtras?.isAiGenerated ?? false,
      replyChainJson:
        input.replyChain && input.replyChain.length > 0
          ? input.replyChain
          : undefined,
      // Strip isAiGenerated from JSON (it lives on Post.aiGenerated) to avoid duplication.
      igExtrasJson: (() => {
        if (!input.igExtras) return undefined;
        const { isAiGenerated: _drop, ...rest } = input.igExtras;
        return Object.keys(rest).length > 0 ? rest : undefined;
      })(),
      assets: {
        create: assetSpecs.map((spec, position) => ({
          assetId: spec.assetId,
          position,
          altText: spec.altText ?? null,
          userTagsJson: spec.userTags && spec.userTags.length > 0 ? spec.userTags : undefined,
        })),
      },
    },
    include: { assets: { include: { asset: true } } },
  });

  // No queue push needed: the Postgres-polling publish runner picks up any
  // post with status="queued" AND scheduledAt <= now() on its next tick.
  return post;
}

export async function listPosts(filter?: {
  status?: PostStatus;
  platform?: Platform;
  from?: Date;
  to?: Date;
}) {
  return prisma.post.findMany({
    where: {
      ...(filter?.status && { status: filter.status }),
      ...(filter?.platform && { platform: filter.platform }),
      ...(filter?.from || filter?.to
        ? {
            scheduledAt: {
              ...(filter.from && { gte: filter.from }),
              ...(filter.to && { lte: filter.to }),
            },
          }
        : {}),
    },
    include: { assets: { include: { asset: true } } },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
    take: 500,
  });
}

export async function getPost(id: string) {
  return prisma.post.findUnique({
    where: { id },
    include: { assets: { include: { asset: true } } },
  });
}

/**
 * Update an existing post. Only allowed on draft/queued/failed posts —
 * once it's published we don't touch it. Changing scheduledAt just updates
 * the row; the polling runner reads scheduledAt live, so no job to reschedule.
 */
export async function updatePost(id: string, input: Partial<CreatePostInput>) {
  const existing = await prisma.post.findUnique({ where: { id } });
  if (!existing) return null;
  if (existing.status === "published") {
    throw new Error("Cannot edit a published post");
  }
  if (existing.status === "publishing") {
    throw new Error("Post is publishing right now; can't edit");
  }

  const scheduledAt =
    input.scheduledAt === undefined
      ? existing.scheduledAt
      : input.scheduledAt
        ? new Date(input.scheduledAt)
        : null;
  const newStatus = scheduledAt ? "queued" : "draft";

  // Authoritative hard-block check. The route schema can only see the patch;
  // this sees the MERGED post, which is what actually reaches the publisher.
  // Without it, a PATCH that omits scheduledAt on an already-queued post would
  // be read as a draft and skip the minimums it must satisfy.
  const mergedType = (input.type ?? existing.type) as RulePostType;
  const mergedCaption =
    input.caption !== undefined ? (input.caption ?? "") : (existing.caption ?? "");
  const mergedMediaCount =
    input.mediaAssetIds !== undefined
      ? input.mediaAssetIds.length
      : await prisma.postAsset.count({ where: { postId: id } });
  const mergedChain =
    input.replyChain !== undefined
      ? input.replyChain
      : (existing.replyChainJson as Array<{ caption?: string; text?: string }> | null);

  const violations = validatePost({
    type: mergedType,
    platform: existing.platform,
    caption: mergedCaption,
    stage: scheduledAt ? "publish" : "draft",
    mediaCount: mergedMediaCount,
    chainItems: Array.isArray(mergedChain)
      ? mergedChain.map((c) => ({
          text: (c as { text?: string; caption?: string }).text ??
            (c as { caption?: string }).caption ?? "",
          assetCount: ((c as { assetIds?: string[] }).assetIds ?? []).length,
        }))
      : undefined,
  });
  if (violations.length > 0) {
    throw new Error(violations.map((v) => v.message).join("; "));
  }

  // Rebuild PostAsset rows if media changed.
  const assetSpecs: AssetMeta[] | undefined = input.assetMetas?.length
    ? input.assetMetas
    : input.mediaAssetIds
      ? input.mediaAssetIds.map((assetId) => ({ assetId }))
      : undefined;

  const post = await prisma.$transaction(async (tx) => {
    if (assetSpecs) {
      await tx.postAsset.deleteMany({ where: { postId: id } });
    }
    return tx.post.update({
      where: { id },
      data: {
        caption: input.caption !== undefined ? (input.caption ?? null) : undefined,
        scheduledAt,
        status: newStatus,
        lastError: null,
        ...(input.topicTag !== undefined
          ? { topicTag: input.topicTag?.trim() ? input.topicTag.trim() : null }
          : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.igExtras !== undefined
          ? {
              aiGenerated: input.igExtras?.isAiGenerated ?? false,
              igExtrasJson: (() => {
                if (!input.igExtras) return null as never;
                const { isAiGenerated: _drop, ...rest } = input.igExtras;
                return Object.keys(rest).length > 0 ? rest : null as never;
              })(),
            }
          : {}),
        ...(input.replyChain !== undefined
          ? {
              replyChainJson:
                input.replyChain && input.replyChain.length > 0
                  ? input.replyChain
                  : null as never,
            }
          : {}),
        ...(assetSpecs
          ? {
              assets: {
                create: assetSpecs.map((spec, position) => ({
                  assetId: spec.assetId,
                  position,
                  altText: spec.altText ?? null,
                  userTagsJson:
                    spec.userTags && spec.userTags.length > 0 ? spec.userTags : undefined,
                })),
              },
            }
          : {}),
      },
      include: { assets: { include: { asset: true } } },
    });
  });

  return post;
}

export async function cancelPost(id: string) {
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) return null;
  if (post.status === "published") {
    throw new Error("Cannot cancel a published post (delete from platform manually)");
  }
  // The polling runner only picks up status="queued"; flipping to "cancelled"
  // takes it out of contention on the next tick.
  return prisma.post.update({
    where: { id },
    data: { status: "cancelled" },
  });
}

// Duplicate a post to the OTHER platform as a draft (IG <-> Threads). Creates a
// brand-new draft on the opposite platform's account, with the caption adapted
// to that platform's voice/length by the existing caption AI, the same media
// re-linked (no re-upload — media URLs are platform-agnostic), and a back-link
// to the source for analytics. Never publishes; never touches the source.
export async function duplicateToOtherPlatform(sourceId: string) {
  const source = await prisma.post.findUnique({
    where: { id: sourceId },
    include: { assets: { include: { asset: true }, orderBy: { position: "asc" } } },
  });
  if (!source) return null;

  const target: Platform =
    source.platform === "instagram" ? "threads" : "instagram";

  const account = await prisma.account.findFirst({
    where: { platform: target },
  });
  if (!account) {
    throw new Error(`No ${target} account connected to duplicate into`);
  }

  // Seed text: caption, or the first reply-chain segment for chains.
  let seed = source.caption?.trim() ?? "";
  if (!seed && Array.isArray(source.replyChainJson)) {
    const segs = source.replyChainJson as Array<{ text?: string }>;
    seed = segs.find((s) => s.text?.trim())?.text?.trim() ?? "";
  }

  const maxChars = target === "threads" ? 500 : 2200;

  // Decide the target type from the media we have.
  const assetMimes = source.assets.map((a) => a.asset.mimeType);
  const hasVideoFirst = assetMimes[0]?.startsWith("video/");
  let targetType: PostType;
  if (target === "threads") {
    targetType = "threads_post";
  } else if (source.assets.length >= 2) {
    targetType = "ig_carousel";
  } else if (source.assets.length === 1 && hasVideoFirst) {
    targetType = "ig_reel";
  } else {
    targetType = "ig_feed"; // single image, or none yet (draft — user adds media)
  }

  // Adapt the caption to the target platform's voice + length. Best-effort: a
  // DeepSeek hiccup must not block the duplicate (it's just a draft).
  let caption: string | undefined;
  if (seed && seed.length >= 10) {
    try {
      const out = await suggestCaptions({
        platform: target,
        postType: targetType,
        mode: "enhance",
        existingCaption: seed,
        count: 1,
      });
      caption = out[0]?.caption?.slice(0, maxChars);
    } catch {
      caption = seed.slice(0, maxChars);
    }
  } else if (seed) {
    caption = seed.slice(0, maxChars);
  }

  const created = await prisma.post.create({
    data: {
      accountId: account.id,
      platform: target,
      type: targetType,
      caption: caption ?? null,
      status: "draft",
      sourcePostId: source.id,
      // Re-link the SAME media assets (carry alt text + tags across).
      assets: {
        create: source.assets.map((pa) => ({
          assetId: pa.assetId,
          position: pa.position,
          altText: pa.altText,
          userTagsJson: pa.userTagsJson ?? undefined,
        })),
      },
    },
    include: { assets: { include: { asset: true } } },
  });

  return { post: created, targetPlatform: target };
}

// Undo a cancel — flip a cancelled post back to draft so the user can
// re-schedule it. Only cancelled posts are restorable (we never resurrect a
// published/failed row this way).
export async function restorePost(id: string) {
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) return null;
  if (post.status !== "cancelled") {
    throw new Error(`Only cancelled posts can be restored (this is ${post.status})`);
  }
  return prisma.post.update({
    where: { id },
    data: { status: "draft" },
  });
}

/**
 * Re-queue a failed (or any non-published) post for an immediate publish attempt.
 * Clears prior PublishJob rows so the runner's attempt counter resets to a fresh
 * 3-attempt budget, then sets status="queued" with scheduledAt=now().
 */
export async function retryPost(id: string) {
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) return null;
  if (post.status === "published") return post;
  await prisma.publishJob.deleteMany({ where: { postId: id } });
  return prisma.post.update({
    where: { id },
    data: {
      status: "queued",
      scheduledAt: new Date(),
      lastError: null,
    },
  });
}

export async function publishNow(id: string) {
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) return null;
  if (post.status === "published") return post;
  await prisma.publishJob.deleteMany({ where: { postId: id } });
  return prisma.post.update({
    where: { id },
    data: { status: "queued", scheduledAt: new Date(), lastError: null },
  });
}
