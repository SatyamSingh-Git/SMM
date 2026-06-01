import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createPost,
  listPosts,
  getPost,
  cancelPost,
  publishNow,
  retryPost,
  updatePost,
} from "../services/posts.js";

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
    text: z.string().max(500).optional(),
    assetIds: z.array(z.string()).max(20).optional(),
  })
  .refine(
    (v) =>
      (v.text && v.text.trim().length > 0) || (v.assetIds && v.assetIds.length > 0),
    { message: "Each chain item needs text or media" }
  );

const CreateBody = z.object({
  accountId: z.string().min(1),
  platform: Platform,
  type: PostType,
  caption: z.string().max(2200).optional(),
  mediaAssetIds: z.array(z.string()).default([]),
  assetMetas: z.array(AssetMeta).max(20).optional(),
  replyChain: z.array(ChainItem).max(20).optional(),
  igExtras: IgExtras.optional(),
  scheduledAt: z.string().datetime().nullish(),
});

// PATCH /posts/:id — everything optional. AccountId/platform are immutable.
const UpdateBody = z.object({
  type: PostType.optional(),
  caption: z.string().max(2200).nullish(),
  mediaAssetIds: z.array(z.string()).optional(),
  assetMetas: z.array(AssetMeta).max(20).optional(),
  replyChain: z.array(ChainItem).max(20).nullish(),
  igExtras: IgExtras.nullish(),
  scheduledAt: z.string().datetime().nullish(),
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
}
