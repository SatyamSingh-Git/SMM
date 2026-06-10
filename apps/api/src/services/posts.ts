import { prisma, type Platform, type PostType, type PostStatus } from "@smm/db";

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
