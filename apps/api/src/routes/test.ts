import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { getConfig } from "../services/runtime-config.js";
import {
  publishText as threadsPublishText,
  getMe as threadsGetMe,
  threadsPostUrl,
} from "../publishers/threads.js";
import {
  publishImage as igPublishImage,
  getMe as igGetMe,
} from "../publishers/instagram.js";

// Stage 1 test routes. These bypass DB + queue and post directly using
// the manual tokens in .env. We use this to verify the pipeline end-to-end
// before wiring up scheduling + persistence.

const ThreadsPostBody = z.object({
  text: z.string().min(1).max(500),
});

const InstagramPostBody = z.object({
  imageUrl: z.string().url(),
  caption: z.string().max(2200).optional(),
});

export async function registerTestRoutes(app: FastifyInstance): Promise<void> {
  // GET /test/whoami — confirms both tokens are valid + returns user info.
  app.get("/test/whoami", async (_req, reply) => {
    if (getConfig().killSwitch) return reply.code(503).send({ error: "kill switch on" });
    const out: Record<string, unknown> = {};
    if (env.THREADS_ACCESS_TOKEN) {
      try {
        out.threads = await threadsGetMe(env.THREADS_ACCESS_TOKEN);
      } catch (e) {
        out.threads = { error: (e as Error).message };
      }
    }
    if (env.INSTAGRAM_ACCESS_TOKEN) {
      try {
        out.instagram = await igGetMe(env.INSTAGRAM_ACCESS_TOKEN);
      } catch (e) {
        out.instagram = { error: (e as Error).message };
      }
    }
    return out;
  });

  // POST /test/threads — publish a text-only Thread.
  app.post("/test/threads", async (req, reply) => {
    if (getConfig().killSwitch) return reply.code(503).send({ error: "kill switch on" });
    const parsed = ThreadsPostBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!env.THREADS_ACCESS_TOKEN) {
      return reply.code(503).send({ error: "THREADS_ACCESS_TOKEN missing" });
    }

    const me = await threadsGetMe(env.THREADS_ACCESS_TOKEN);
    const published = await threadsPublishText(me.id, env.THREADS_ACCESS_TOKEN, {
      text: parsed.data.text,
    });
    return {
      ok: true,
      id: published.id,
      url: threadsPostUrl(me.username, published.id),
    };
  });

  // POST /test/instagram — publish a single image post.
  // imageUrl must be a public HTTPS JPEG.
  app.post("/test/instagram", async (req, reply) => {
    if (getConfig().killSwitch) return reply.code(503).send({ error: "kill switch on" });
    const parsed = InstagramPostBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!env.INSTAGRAM_USER_ID || !env.INSTAGRAM_ACCESS_TOKEN) {
      return reply
        .code(503)
        .send({ error: "INSTAGRAM_USER_ID/ACCESS_TOKEN missing" });
    }

    const published = await igPublishImage(
      env.INSTAGRAM_USER_ID,
      env.INSTAGRAM_ACCESS_TOKEN,
      parsed.data
    );
    return { ok: true, id: published.id };
  });
}
