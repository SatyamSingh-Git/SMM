import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { suggestCaptions } from "../services/ai.js";

const VoiceModifier = z.enum([
  "playful",
  "cute",
  "controversial",
  "flirty",
  "bold",
  "mysterious",
  "soft",
  "edgy",
  "viral-bait",
]);

const CaptionBody = z.object({
  platform: z.enum(["instagram", "threads"]),
  postType: z.enum([
    "ig_feed",
    "ig_carousel",
    "ig_reel",
    "ig_story",
    "threads_post",
    "threads_reply_chain",
  ]),
  mode: z.enum(["fresh", "enhance", "from-image"]).default("fresh"),
  existingCaption: z.string().max(5000).optional(),
  imageUrl: z.string().url().optional(),
  voices: z.array(VoiceModifier).max(9).optional(),
  languageMix: z
    .enum(["english", "balanced", "hindi-heavy"])
    .default("english"),
  intent: z.string().max(500).optional(),
  count: z.number().int().min(1).max(5).default(3),
});

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  app.post("/ai/caption-suggest", async (req, reply) => {
    const parsed = CaptionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;
    if (d.mode === "enhance" && !d.existingCaption?.trim()) {
      return reply.code(400).send({ error: "enhance mode needs existingCaption" });
    }
    if (d.mode === "from-image" && !d.imageUrl) {
      return reply.code(400).send({ error: "from-image mode needs imageUrl" });
    }
    try {
      const suggestions = await suggestCaptions({
        platform: d.platform,
        postType: d.postType,
        mode: d.mode,
        existingCaption: d.existingCaption,
        imageUrl: d.imageUrl,
        voices: d.voices,
        languageMix: d.languageMix,
        userIntent: d.intent,
        count: d.count,
      });
      return { suggestions };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
