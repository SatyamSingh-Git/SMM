import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createPost,
  listPosts,
  getPost,
  cancelPost,
  restorePost,
  duplicateToOtherPlatform,
  publishNow,
  retryPost,
  updatePost,
} from "../services/posts.js";
import { duplicateAsThreadsDraft } from "../services/duplicate-threads.js";
import {
  CHAIN_ITEM_MAX,
  CHAIN_MAX_ITEMS,
  validatePost,
  type PostType as RulePostType,
} from "@smm/shared";

const Platform = z.enum(["instagram", "threads"]);
const PostType = z.enum([
  "ig_feed",
  "ig_carousel",
  "ig_reel",
  "ig_story",
  "threads_post",
  "threads_reply_chain",
]);

const UserTag = z.object({
  username: z.string().min(1).max(60),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const AssetMeta = z.object({
  assetId: z.string().min(1),
  altText: z.string().max(1000).optional(),
  userTags: z.array(UserTag).max(20).optional(),
});

const IgExtras = z.object({
  locationId: z.string().min(1).optional(),
  locationName: z.string().optional(),
  collaborators: z.array(z.string().min(1).max(60)).max(5).optional(),
  thumbOffsetMs: z.number().int().min(0).optional(),
  coverUrl: z.string().url().optional(),
  isAiGenerated: z.boolean().optional(),
});

// One item in a Threads reply chain. Text is now optional (you can post
// a media-only thread reply); assetIds references MediaAsset rows uploaded
// for this post.
const ChainItem = z
  .object({
    text: z.string().max(CHAIN_ITEM_MAX).optional(),
    assetIds: z.array(z.string()).max(CHAIN_MAX_ITEMS).optional(),
  })
  .refine(
    (v) =>
      (v.text && v.text.trim().length > 0) || (v.assetIds && v.assetIds.length > 0),
    { message: "Each chain item needs text or media" }
  );

export const CreateBody = z
  .object({
    accountId: z.string().min(1),
    platform: Platform,
    type: PostType,
    caption: z.string().max(2200).optional(),
    mediaAssetIds: z.array(z.string()).default([]),
    assetMetas: z.array(AssetMeta).max(20).optional(),
    replyChain: z.array(ChainItem).max(20).optional(),
    igExtras: IgExtras.optional(),
    topicTag: z.string().max(50).nullish(),
    scheduledAt: z.string().datetime().nullish(),
  })
  // Deterministic Meta rejections, caught before the post reaches the queue.
  // The publish retry exists for TRANSIENT failures; a post that breaks one of
  // these can never succeed, so letting it through only burns three attempts
  // and leaves a failed row. The rules live in @smm/shared so the composer UI
  // and both write paths read one table.
  .superRefine((v, ctx) => {
    for (const violation of validatePost({
      type: v.type,
      platform: v.platform,
      caption: v.caption,
      // A post with no scheduledAt is a draft the user is still assembling, so
      // "not enough media yet" is not an error. Everything else still is.
      stage: v.scheduledAt ? "publish" : "draft",
      mediaCount: v.mediaAssetIds.length,
      chainItems: v.replyChain?.map((c) => ({
        text: c.text,
        assetCount: c.assetIds?.length ?? 0,
      })),
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [violation.field],
        message: violation.message,
      });
    }
  });

// PATCH /posts/:id — everything optional. AccountId/platform are immutable.
//
// This used to have no superRefine at all, so the hard blocks applied on create
// but not on edit: a PATCH could set a Threads caption over 500 chars, or a
// 1-item carousel — both guaranteed Meta rejections — and they went straight to
// the publish queue. Editing a queued post is a normal path, so the gap was
// reachable. It now runs the same shared validator as create.
//
// Only the fields present in the patch can be checked here; `type` has to be
// among them for a rule to apply, since the rules are keyed by post type.
export const UpdateBody = z
  .object({
    type: PostType.optional(),
    caption: z.string().max(2200).nullish(),
    mediaAssetIds: z.array(z.string()).optional(),
    assetMetas: z.array(AssetMeta).max(20).optional(),
    replyChain: z.array(ChainItem).max(CHAIN_MAX_ITEMS).nullish(),
    igExtras: IgExtras.nullish(),
    topicTag: z.string().max(50).nullish(),
    scheduledAt: z.string().datetime().nullish(),
  })
  .superRefine((v, ctx) => {
    if (!v.type) return;
    for (const violation of validatePost({
      type: v.type as RulePostType,
      caption: v.caption ?? undefined,
      stage: v.scheduledAt ? "publish" : "draft",
      mediaCount: v.mediaAssetIds?.length,
      chainItems: v.replyChain?.map((c) => ({
        text: c.text,
        assetCount: c.assetIds?.length ?? 0,
      })),
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [violation.field],
        message: violation.message,
      });
    }
  });

const ListQuery = z.object({
  status: z
    .enum(["draft", "queued", "publishing", "published", "failed", "cancelled"])
    .optional(),
  platform: Platform.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function registerPostRoutes(app: FastifyInstance): Promise<void> {
  app.post("/posts", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const post = await createPost(parsed.data);
    return post;
  });

  app.get("/posts", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { status, platform, from, to } = parsed.data;
    const posts = await listPosts({
      status,
      platform,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return { posts };
  });

  app.get<{ Params: { id: string } }>("/posts/:id", async (req, reply) => {
    const post = await getPost(req.params.id);
    if (!post) return reply.code(404).send({ error: "not found" });
    return post;
  });

  app.patch<{ Params: { id: string } }>("/posts/:id", async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const post = await updatePost(req.params.id, {
        ...parsed.data,
        caption: parsed.data.caption ?? undefined,
        replyChain: parsed.data.replyChain ?? undefined,
        igExtras: parsed.data.igExtras ?? undefined,
      });
      if (!post) return reply.code(404).send({ error: "not found" });
      return post;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/posts/:id",
    async (req, reply) => {
      const post = await cancelPost(req.params.id);
      if (!post) return reply.code(404).send({ error: "not found" });
      return post;
    }
  );

  // Duplicate a post to the other platform as a draft (IG <-> Threads).
  app.post<{ Params: { id: string } }>(
    "/posts/:id/duplicate",
    async (req, reply) => {
      try {
        const out = await duplicateToOtherPlatform(req.params.id);
        if (!out) return reply.code(404).send({ error: "not found" });
        return out;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
  );

  // Undo a cancel/delete — flips a cancelled post back to draft.
  app.post<{ Params: { id: string } }>(
    "/posts/:id/restore",
    async (req, reply) => {
      try {
        const post = await restorePost(req.params.id);
        if (!post) return reply.code(404).send({ error: "not found" });
        return post;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/posts/:id/publish-now",
    async (req, reply) => {
      const post = await publishNow(req.params.id);
      if (!post) return reply.code(404).send({ error: "not found" });
      return post;
    }
  );

  app.post<{ Params: { id: string } }>(
    "/posts/:id/retry",
    async (req, reply) => {
      const post = await retryPost(req.params.id);
      if (!post) return reply.code(404).send({ error: "not found" });
      return post;
    }
  );

  // Duplicate any post as a native Threads draft (rewrites caption to the
  // Threads voice). Creates a SEPARATE draft the user edits + schedules.
  app.post<{ Params: { id: string } }>(
    "/posts/:id/duplicate-as-threads",
    async (req, reply) => {
      try {
        const result = await duplicateAsThreadsDraft(req.params.id);
        if (!result) return reply.code(404).send({ error: "not found" });
        return result;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
  );
}
