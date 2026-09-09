import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  generateImagePrompts,
  generateCarouselCompanion,
  getOptionCatalog,
} from "../services/image-prompts.js";
import { subjectDescriptor } from "../services/prompt/system.js";

const Body = z.object({
  scene: z.string().min(2).max(500),
  personaDescriptor: z.string().max(2000).optional(),
  count: z.number().int().min(1).max(6).default(3),
  outfit: z
    .enum([
      "saree_silk",
      "saree_sheer",
      "lehenga",
      "crop_denim",
      "mini_skirt",
      "micro_shorts",
      "bodycon",
      "oversized_tee",
      "swim_two_piece",
      "gym_set",
      "towel_robe",
      "slip_dress",
      "kurta_co_ord",
    ])
    .optional(),
  shotType: z
    .enum([
      "posed_editorial",
      "casual_posed",
      "candid_aware",
      "candid_unaware",
      "sudden_snap",
      "behind_the_scenes",
      "random_phone",
    ])
    .optional(),
  cameraQuality: z
    .enum([
      "dslr_pro",
      "film_35mm",
      "iphone_snap",
      "vintage_pns",
      "cheap_webcam",
      "mirrorless_film_look",
      "old_phone",
    ])
    .optional(),
  photographer: z
    .enum([
      "pro_photographer",
      "friend_with_phone",
      "boyfriend",
      "self_timer",
      "mirror_self",
      "newbie",
    ])
    .optional(),
  cameraAngles: z
    .array(
      z.enum([
        "eye_level_direct",
        "eye_level_away",
        "low_hero",
        "high_above",
        "from_behind",
        "three_quarter_back",
        "floor_low",
        "between_legs",
        "mirror_reflection",
        "overhead_flat",
        "over_shoulder",
      ])
    )
    .max(6)
    .optional(),
  locale: z
    .enum([
      "delhi_urban",
      "mumbai_urban",
      "bangalore_urban",
      "tier2_city",
      "rural_village",
      "hill_station",
      "beach_goa",
      "studio",
      "bedroom_personal",
      "cafe_interior",
      "hostel_room",
    ])
    .optional(),
  lighting: z
    .enum([
      "golden_hour",
      "blue_hour",
      "harsh_noon",
      "overcast_soft",
      "window_light",
      "tungsten_warm",
      "fluorescent_cool",
      "neon_night",
      "direct_flash",
      "low_light_grain",
      "bad_lighting",
    ])
    .optional(),
  hairstyles: z
    .array(
      z.enum([
        "long_loose_wavy",
        "long_loose_straight",
        "high_ponytail",
        "low_ponytail",
        "loose_low_bun",
        "top_knot",
        "half_up_down",
        "side_braid",
        "two_braids",
        "wet_slicked",
        "messy_bedhead",
        "wind_swept",
        "claw_clip",
        "curtain_bangs",
      ])
    )
    .max(14)
    .optional(),
  defaultPersonality: z.boolean().optional(),
});

export async function registerImagePromptRoutes(
  app: FastifyInstance
): Promise<void> {
  app.log.info("[image-prompts] registering routes");

  // GET /ai/image-prompts/persona — default persona descriptor for the UI.
  app.get("/ai/image-prompts/persona", async () => {
    return { defaultPersona: subjectDescriptor() };
  });

  // GET /ai/image-prompts/options — chip catalog for the UI. Single source of
  // truth so the frontend doesn't drift from backend enum values.
  app.get("/ai/image-prompts/options", async () => {
    return { options: getOptionCatalog() };
  });

  // POST /ai/image-prompts — generate N image-gen prompts for one scene.
  app.post("/ai/image-prompts", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const prompts = await generateImagePrompts(parsed.data);
      return { prompts };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // POST /ai/image-prompts/carousel-text — given the generated prompts, write
  // the IG caption + per-slide micro-captions + alt text for the carousel.
  app.post("/ai/image-prompts/carousel-text", async (req, reply) => {
    const Body2 = z.object({
      prompts: z.array(z.string().min(1)).min(1).max(10),
    });
    const parsed = Body2.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const companion = await generateCarouselCompanion(parsed.data.prompts);
      return companion;
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
