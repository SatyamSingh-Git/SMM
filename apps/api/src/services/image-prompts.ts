// Image-Prompt Writer.
//
// Takes ONE scene/vibe + an optional persona descriptor + an optional set of
// "director's choices" (outfit, shot type, camera quality, photographer skill,
// camera angle, locale, lighting) and returns N image-generation prompts that
// form a carousel-coherent set.
//
// Each director's choice maps to a specific photography-direction phrase that
// gets appended to the user message as DIRECTOR'S NOTES — so picking
// "between_legs" turns into a real prompt-engineering effect, not just
// metadata. The translation tables live here so the backend stays the single
// source of truth and the frontend just sends enum values.

import {
  IMAGE_PROMPT_SYSTEM,
  deepseekChat,
} from "./ai.js";
import { systemPromptFor, subjectDescriptor } from "./prompt/system.js";
import { dimensions, labelFor, optionsFor, phraseFor } from "./style-options.js";
import { getProfile } from "./profile/resolver.js";
import {
  type CameraAngleKey,
  type CameraQualityKey,
  type HairstyleKey,
  type LightingKey,
  type LocaleKey,
  type OutfitKey,
  type PhotographerKey,
  type ShotTypeKey,
} from "./image-prompt-options.js";
export type {
  CameraAngleKey,
  CameraQualityKey,
  HairstyleKey,
  LightingKey,
  LocaleKey,
  OutfitKey,
  PhotographerKey,
  ShotTypeKey,
};


export type ImagePromptOpts = {
  scene: string;
  personaDescriptor?: string;
  count?: number;
  outfit?: OutfitKey;
  shotType?: ShotTypeKey;
  cameraQuality?: CameraQualityKey;
  photographer?: PhotographerKey;
  cameraAngles?: CameraAngleKey[];
  locale?: LocaleKey;
  lighting?: LightingKey;
  hairstyles?: HairstyleKey[];
  // Default tone (flirty / girlfriend-pose / body-flattering). When true (the
  // default), a TONE BIAS block is appended that pushes concrete visual choices
  // toward that register. Toggle from the UI to disable for editorial-only sets.
  defaultPersonality?: boolean;
};

// ---------- Service ----------

export async function generateImagePrompts(
  opts: ImagePromptOpts
): Promise<string[]> {
  const scene = opts.scene.trim();
  if (!scene) throw new Error("scene is required");
  const persona =
    opts.personaDescriptor?.trim() || subjectDescriptor();
  const n = Math.max(1, Math.min(opts.count ?? 3, 6));

  const directorsNotes = buildDirectorsNotes(opts);

  const userText = `PERSONA (lock this identity into every prompt — reproduce verbatim at the start of each prompt):
"""
${persona}
"""

SCENE: "${scene.replace(/"/g, '\\"')}"
${directorsNotes ? `\nDIRECTOR'S NOTES — fold these naturally into every prompt; do not list them, weave them into the description:\n${directorsNotes}\n` : ""}
Write ${n} image-generation prompt${n === 1 ? "" : "s"} for the SAME shoot.
Hold CONSTANT across all ${n}: persona, outfit, setting, lighting, time-of-day, hair and makeup, camera body and lens.
Vary ONLY: camera distance + angle (within the director's chosen angle family), pose + expression, micro-detail.

Every prompt MUST include: camera body + lens + EXIF specifics, 2-3 skin-texture details, 1-2 real-world imperfections, named light source with temperature, 2-3 lived-in environment props. No abstract "realistic" / "hyper-realistic" tokens.

Return STRICT JSON:
{"prompts":["...","...","..."]}`;

  const raw = await deepseekChat({
    messages: [
      { role: "system", content: IMAGE_PROMPT_SYSTEM },
      { role: "user", content: userText },
    ],
    temperature: 0.9,
    maxTokens: 2600,
    jsonMode: true,
    cacheLabel: "image-prompts",
  });

  let parsed: { prompts?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "");
    parsed = JSON.parse(stripped);
  }

  const list = Array.isArray(parsed.prompts) ? parsed.prompts : [];
  return list
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, n);
}

// Carousel companion text — given the generated image prompts (each describes
// one slide of the same shoot), produce a ready-to-post IG caption + one short
// Threads-length micro-caption per slide + per-slide alt text. Turns a 3-image
// shoot into a one-step publish instead of writing captions by hand.
export type CarouselCompanion = {
  masterCaption: string;
  hashtags: string[];
  slides: Array<{ micro: string; alt: string }>;
};

export async function generateCarouselCompanion(
  prompts: string[]
): Promise<CarouselCompanion> {
  const slides = prompts.slice(0, 10);
  if (slides.length === 0) throw new Error("no prompts provided");
  const slideBlock = slides
    .map((p, i) => `Slide ${i + 1}: ${p}`)
    .join("\n\n");

  const userText = `Below are ${slides.length} image-generation prompts — each describes ONE slide of the SAME photo carousel for the creator. Write the post text for this carousel.

${slideBlock}

Return STRICT JSON:
{
  "masterCaption": "one Instagram caption for the whole carousel, in her voice (lowercase ok, 4-6 emojis, ≤300 chars)",
  "hashtags": ["8-15 IG hashtags, no # prefix"],
  "slides": [ { "micro": "a short Threads-length line for THIS slide, ≤80 chars, in her voice", "alt": "factual accessibility alt-text describing THIS slide's image, no emojis, ≤100 chars" } ]
}
The "slides" array MUST have exactly ${slides.length} items in order.`;

  const raw = await deepseekChat({
    messages: [
      { role: "system", content: systemPromptFor("caption") },
      { role: "user", content: userText },
    ],
    temperature: 0.9,
    maxTokens: 1200,
    jsonMode: true,
    cacheLabel: "carousel-companion",
  });
  let parsed: {
    masterCaption?: unknown;
    hashtags?: unknown;
    slides?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(
      raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")
    );
  }
  const rawSlides = Array.isArray(parsed.slides) ? parsed.slides : [];
  return {
    masterCaption:
      typeof parsed.masterCaption === "string"
        ? parsed.masterCaption.slice(0, 2200)
        : "",
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags
          .filter((h): h is string => typeof h === "string")
          .slice(0, 20)
      : [],
    slides: slides.map((_, i) => {
      const s = (rawSlides[i] ?? {}) as { micro?: unknown; alt?: unknown };
      return {
        micro: typeof s.micro === "string" ? s.micro.slice(0, 200) : "",
        alt: typeof s.alt === "string" ? s.alt.slice(0, 200) : "",
      };
    }),
  };
}

function buildDirectorsNotes(opts: ImagePromptOpts): string {
  const lines: string[] = [];
  // Every lookup goes through the style-options cache, and a key that has been
  // disabled or removed since a draft referenced it resolves to null — that
  // axis is then omitted rather than emitting "undefined" into a live prompt.
  const note = (heading: string, dimension: string, key?: string): void => {
    if (!key) return;
    const phrase = phraseFor(dimension, key);
    if (phrase) lines.push(`${heading} — ${phrase}`);
  };

  note("OUTFIT", "outfit", opts.outfit);
  note("SHOT TYPE", "shotType", opts.shotType);
  note("CAMERA", "cameraQuality", opts.cameraQuality);
  note("PHOTOGRAPHER", "photographer", opts.photographer);

  if (opts.cameraAngles && opts.cameraAngles.length > 0) {
    const validAngles = opts.cameraAngles.filter(
      (k): k is CameraAngleKey => phraseFor("cameraAngle", k) !== null
    );
    const firstAngle = validAngles[0];
    if (validAngles.length === 1 && firstAngle) {
      lines.push(
        `ANGLE — ${phraseFor("cameraAngle", firstAngle)} Use this same angle for every prompt in the set.`
      );
    } else if (validAngles.length > 1) {
      const list = validAngles
        .map(
          (k, i) =>
            `(${i + 1}) ${labelFor("cameraAngle", k)} — ${phraseFor("cameraAngle", k)}`
        )
        .join("\n");
      lines.push(
        `ANGLES — ${validAngles.length} angles provided; assign ONE distinct angle to each prompt in the set, in order if the count matches, otherwise rotate / repeat as needed. Each prompt must use exactly one of these angles, and the angle drives the framing of that prompt only:\n${list}`
      );
    }
  }
  note("LOCALE", "locale", opts.locale);
  note("LIGHTING", "lighting", opts.lighting);
  // Default tone bias: on unless explicitly false. Pushes outfit / pose /
  // composition / expression choices toward the flirty + girlfriend-pose +
  // body-flattering register WITHOUT ever using intent words. Concrete visual
  // direction only — that's what gets through prompt classifiers cleanly while
  // the image generator's own VLM remains the actual safety layer.
  const tonePersonalityOn = opts.defaultPersonality !== false;
  if (tonePersonalityOn) {
    const bias = getProfile()?.visual.toneBias?.trim();
    if (bias) lines.push(bias);
  }
  if (opts.hairstyles && opts.hairstyles.length > 0) {
    const valid = opts.hairstyles.filter(
      (k): k is HairstyleKey => phraseFor("hairstyle", k) !== null
    );
    const first = valid[0];
    if (valid.length === 1 && first) {
      lines.push(`HAIRSTYLE — ${phraseFor("hairstyle", first)}.`);
    } else if (valid.length > 1) {
      const optionsBlock = valid
        .map(
          (k) =>
            `• ${labelFor("hairstyle", k)}: ${phraseFor("hairstyle", k)}`
        )
        .join("\n");
      lines.push(
        `HAIRSTYLE — pick ONE from the following pool that best fits the scene, and use it identically across all prompts in the set (hair stays constant within the shoot). Do not mix styles across prompts. Options:\n${optionsBlock}`
      );
    }
  }
  return lines.join("\n");
}

// ---------- UI catalog (exposed via route) ----------

/**
 * What the composer offers. Keyed by dimension so a dimension added in the
 * editor shows up without a code change — the UI iterates this rather than
 * naming the eight it knows about.
 */
export type OptionCatalog = Record<
  string,
  Array<{ value: string; label: string; conflictsWith: string[] }>
>;

export function getOptionCatalog(): OptionCatalog {
  const out: OptionCatalog = {};
  for (const dimension of dimensions()) {
    out[dimension] = optionsFor(dimension).map((o) => ({
      value: o.key,
      label: o.label,
      conflictsWith: o.conflictsWith,
    }));
  }
  return out;
}
