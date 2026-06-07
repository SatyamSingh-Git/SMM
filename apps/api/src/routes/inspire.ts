import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inspireFromPost } from "../services/inspire.js";

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

const InspireBody = z.object({
  platform: z.enum(["instagram", "threads"]),
  sourceText: z.string().max(5000).optional(),
  imageUrl: z.string().url().optional(),
  voices: z.array(VoiceModifier).max(9).optional(),
  languageMix: z.enum(["english", "balanced", "hindi-heavy"]).default("english"),
  count: z.number().int().min(1).max(6).default(4),
});

export async function registerInspireRoutes(app: FastifyInstance): Promise<void> {
  // "What to Write": given another post's text and/or image, return brand-new
  // post ideas written in the creator's own voice. Reuses the caption AI.
  app.post("/ai/inspire", async (req, reply) => {
    const parsed = InspireBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;
    if (!d.sourceText?.trim() && !d.imageUrl) {
      return reply
        .code(400)
        .send({ error: "provide sourceText, imageUrl, or both" });
    }
    try {
      const suggestions = await inspireFromPost({
        platform: d.platform,
        sourceText: d.sourceText,
        imageUrl: d.imageUrl,
        voices: d.voices,
        languageMix: d.languageMix,
        count: d.count,
      });
      return { suggestions };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
