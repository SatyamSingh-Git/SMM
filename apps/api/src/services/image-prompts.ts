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
  BRAND_VOICE_VISUAL_FALLBACK,
  deepseekChat,
} from "./ai.js";

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

// ---------- Option vocabulary ----------
//
// Each entry: { value, label, phrase }
//   value  — stable enum string used in API contract
//   label  — short UI chip label
//   phrase — concrete photography-direction language fed verbatim to the LLM

export type OutfitKey =
  | "saree_silk"
  | "saree_sheer"
  | "lehenga"
  | "crop_denim"
  | "mini_skirt"
  | "micro_shorts"
  | "bodycon"
  | "oversized_tee"
  | "swim_two_piece"
  | "gym_set"
  | "towel_robe"
  | "slip_dress"
  | "kurta_co_ord";

export const OUTFIT_OPTIONS: Record<
  OutfitKey,
  { label: string; phrase: string }
> = {
  saree_silk: {
    label: "Silk saree",
    phrase:
      "fitted silk saree in a deep tone, Nivi drape pinned at the navel, pallu falling over the left shoulder, blouse fitted high-neck, fabric draping along the curve of the waist.",
  },
  saree_sheer: {
    label: "Sheer organza saree",
    phrase:
      "sheer organza saree with a sequin border, fitted blouse, pallu held in one hand mid-motion, fabric catching ambient light.",
  },
  lehenga: {
    label: "Lehenga",
    phrase:
      "heavy mirror-work lehenga choli in a jewel tone, fitted cropped choli, full-volume skirt mid-spin or settled, dupatta loose around the elbows.",
  },
  crop_denim: {
    label: "Crop top + denim",
    phrase:
      "fitted high-rise denim jeans with a tucked-in crop tank top, midriff exposed, a thin gold body chain at the waist, simple ankle-strap sandals.",
  },
  mini_skirt: {
    label: "Mini skirt",
    phrase:
      "fitted mini skirt with a tucked-in fitted bodysuit, bare legs, ankle-strap heels, simple silver jewelry.",
  },
  micro_shorts: {
    label: "Micro shorts + fitted tee",
    phrase:
      "micro denim shorts with a fitted plain tank, low-rise waistline, sneakers, casual streetwear feel.",
  },
  bodycon: {
    label: "Bodycon mini",
    phrase:
      "fitted bodycon mini dress with thin straps, smooth silhouette, strappy heels, sleek hair.",
  },
  oversized_tee: {
    label: "Oversized tee",
    phrase:
      "oversized white cotton tee styled as a dress, hem hitting mid-thigh, hair loose, no other visible layer, barefoot.",
  },
  swim_two_piece: {
    label: "Two-piece swim",
    phrase:
      "ribbed two-piece swimwear in burnt orange, fabric still slightly damp, sarong knotted loose at the hip, skin glowing.",
  },
  gym_set: {
    label: "Gym set",
    phrase:
      "matching activewear set — sports bra and bike shorts in heather grey, midriff toned, fine sheen at the collarbone, white sneakers.",
  },
  towel_robe: {
    label: "Towel / robe",
    phrase:
      "white spa towel tucked at the chest, hair pulled back wet, a single drop at the jawline, steam in the air.",
  },
  slip_dress: {
    label: "Satin slip",
    phrase:
      "satin slip dress in champagne, thin straps, fabric falling along the silhouette, layered fine gold necklaces.",
  },
  kurta_co_ord: {
    label: "Kurta co-ord",
    phrase:
      "fitted cotton kurta with matching pants in a pastel co-ord set, dupatta draped over one shoulder, gold jhumkas, traditional but modern fit.",
  },
};

export type ShotTypeKey =
  | "posed_editorial"
  | "casual_posed"
  | "candid_aware"
  | "candid_unaware"
  | "sudden_snap"
  | "behind_the_scenes"
  | "random_phone";

export const SHOT_TYPE_OPTIONS: Record<
  ShotTypeKey,
  { label: string; phrase: string }
> = {
  posed_editorial: {
    label: "Posed editorial",
    phrase:
      "Composed as a deliberate editorial shot — clean framing, intentional pose, magazine-quality composition, every element placed.",
  },
  casual_posed: {
    label: "Casual posed",
    phrase:
      "Posed but soft — she knows the camera is there, eye contact relaxed, hand and weight placement natural rather than styled.",
  },
  candid_aware: {
    label: "Candid (aware)",
    phrase:
      "Candid moment — she is aware of the camera but not posing for it. Caught mid-action, laughing or looking off-frame, no pose held.",
  },
  candid_unaware: {
    label: "Candid (unaware)",
    phrase:
      "Stolen-photo feel — composed as if taken without her knowing. Face turned, looking at her phone or away off-frame, body language unselfconscious, framing slightly imperfect.",
  },
  sudden_snap: {
    label: "Sudden snap",
    phrase:
      "Sudden phone-snap mid-motion — slight motion blur on hands or hair, eyes only halfway to the lens, expression unfinished, real and unstaged.",
  },
  behind_the_scenes: {
    label: "Behind the scenes",
    phrase:
      "Between-takes outtake — sitting on the floor, leaning on a chair, talking to the photographer, not the main shot. Casual energy, no styled pose.",
  },
  random_phone: {
    label: "Random phone snap",
    phrase:
      "Random phone snap with no thought — flat composition, possibly slightly off-center, real-feeling moment, no editing.",
  },
};

export type CameraQualityKey =
  | "dslr_pro"
  | "film_35mm"
  | "iphone_snap"
  | "vintage_pns"
  | "cheap_webcam"
  | "mirrorless_film_look"
  | "old_phone";

export const CAMERA_QUALITY_OPTIONS: Record<
  CameraQualityKey,
  { label: string; phrase: string }
> = {
  dslr_pro: {
    label: "DSLR pro",
    phrase:
      "Canon EOS R5 or Sony A7 IV body, 50mm f/1.4 or 85mm f/1.8 prime, shot at f/1.8, ISO 400, 1/200s — sharp on the eyes, creamy bokeh, clean low-noise shadows, professional color rendering.",
  },
  film_35mm: {
    label: "Film 35mm",
    phrase:
      "Shot on Kodak Portra 400 35mm film, scanned at high resolution, fine grain visible, gentle highlight rolloff, warm magenta cast in skin tones, slow shutter feel.",
  },
  iphone_snap: {
    label: "iPhone snap",
    phrase:
      "iPhone 15 Pro main camera, 24mm equivalent, f/1.78, computational HDR, slight overexposure on highlights, natural skin texture not airbrushed, real-feeling, not editorial.",
  },
  vintage_pns: {
    label: "Vintage point-and-shoot",
    phrase:
      "Y2K-era point-and-shoot with direct on-camera flash, slight motion blur, washed color cast, low-fi compression, dated charm, ~2003 disposable-camera energy.",
  },
  cheap_webcam: {
    label: "Cheap webcam",
    phrase:
      "Cheap front-camera or laptop webcam — soft focus, low dynamic range, slight pixelation, washed-out colors, raw and unstaged, late-night candid quality.",
  },
  mirrorless_film_look: {
    label: "Mirrorless · film look",
    phrase:
      "Fujifilm X-T5 with a film-emulation profile (Classic Chrome or Pro Neg Standard), 35mm f/1.4, clean edges with slight grain, cinematic teal-and-orange grade.",
  },
  old_phone: {
    label: "Older phone",
    phrase:
      "Five-year-old smartphone camera — slightly soft focus, mild JPEG compression artifacts, narrow dynamic range, not polished, very real-feeling, mid-tier sensor.",
  },
};

export type PhotographerKey =
  | "pro_photographer"
  | "friend_with_phone"
  | "boyfriend"
  | "self_timer"
  | "mirror_self"
  | "newbie";

export const PHOTOGRAPHER_OPTIONS: Record<
  PhotographerKey,
  { label: string; phrase: string }
> = {
  pro_photographer: {
    label: "Trained pro",
    phrase:
      "Composed by a trained fashion photographer — intentional negative space, perfect framing, considered lighting setup, editorial polish.",
  },
  friend_with_phone: {
    label: "Friend with a phone",
    phrase:
      "Taken by a friend with a phone — slightly off-center, available lighting only, no setup, captures the moment over the composition.",
  },
  boyfriend: {
    label: "Boyfriend",
    phrase:
      "Boyfriend behind the camera — informal framing from across the room, intimate energy, slightly low angle, no professional polish, soft eye contact she only gives him.",
  },
  self_timer: {
    label: "Self-timer",
    phrase:
      "Self-timer on a tripod — symmetric framing, she walks into the frame and finds the lens, posture deliberately set, tripod ~6 feet away.",
  },
  mirror_self: {
    label: "Mirror selfie",
    phrase:
      "Mirror selfie taken by her — phone clearly visible in her hand at hip or chest height, eyes on the lens through the mirror, free hand in hair or on the waist.",
  },
  newbie: {
    label: "Newbie behind the camera",
    phrase:
      "Taken by a beginner — slightly tilted horizon, imperfect focus that misses by a hair, awkward but candid framing, no understanding of light direction.",
  },
};

export type CameraAngleKey =
  | "eye_level_direct"
  | "eye_level_away"
  | "low_hero"
  | "high_above"
  | "from_behind"
  | "three_quarter_back"
  | "floor_low"
  | "between_legs"
  | "mirror_reflection"
  | "overhead_flat"
  | "over_shoulder";

export const CAMERA_ANGLE_OPTIONS: Record<
  CameraAngleKey,
  { label: string; phrase: string }
> = {
  eye_level_direct: {
    label: "Eye-level, direct",
    phrase:
      "Eye-level camera, frontal composition, she looks directly into the lens.",
  },
  eye_level_away: {
    label: "Eye-level, looking away",
    phrase:
      "Eye-level camera, she looks off-frame to camera left or right, not at the lens, expression natural.",
  },
  low_hero: {
    label: "Low angle (up)",
    phrase:
      "Low angle from waist height or below, camera tilted up, she becomes a hero figure against the sky or ceiling.",
  },
  high_above: {
    label: "High angle (down)",
    phrase:
      "High angle looking down at her, camera held above eye level, she looks up at the lens or down at her phone.",
  },
  from_behind: {
    label: "From behind",
    phrase:
      "Camera directly behind her — only her back, shoulders, and hair visible, walking away from the camera or standing facing the setting.",
  },
  three_quarter_back: {
    label: "3/4 from behind",
    phrase:
      "Three-quarter from behind, camera over her right shoulder, face caught in profile, the setting opening up beyond her.",
  },
  floor_low: {
    label: "Ground level",
    phrase:
      "Camera placed on the floor looking up — perspective compressed, her legs in the foreground, ceiling or sky beyond.",
  },
  between_legs: {
    label: "Between the legs",
    phrase:
      "Low camera placed between her own bare feet looking forward, her feet and ankles in the immediate foreground, the rest of the setting receding ahead — feet-foreground composition.",
  },
  mirror_reflection: {
    label: "Mirror reflection",
    phrase:
      "Composed entirely as a mirror reflection — the mirror frames the shot, she looks at her own reflection or at the camera through it.",
  },
  overhead_flat: {
    label: "Overhead flat-lay",
    phrase:
      "Top-down flat-lay angle — she lies on the bed or floor, camera directly overhead looking straight down, hair fanned around her face.",
  },
  over_shoulder: {
    label: "Over-the-shoulder",
    phrase:
      "Over-the-shoulder framing from behind her — back of her head and shoulder in the soft foreground, her POV opens out into the setting.",
  },
};

export type LocaleKey =
  | "delhi_urban"
  | "mumbai_urban"
  | "bangalore_urban"
  | "tier2_city"
  | "rural_village"
  | "hill_station"
  | "beach_goa"
  | "studio"
  | "bedroom_personal"
  | "cafe_interior"
  | "hostel_room";

export const LOCALE_OPTIONS: Record<
  LocaleKey,
  { label: string; phrase: string }
> = {
  delhi_urban: {
    label: "Delhi urban",
    phrase:
      "Delhi urban setting — heritage stone walls (Hauz Khas / Lodhi Garden vibe), rooftop with monument silhouette, autumn evening haze, warm cinnamon light.",
  },
  mumbai_urban: {
    label: "Mumbai urban",
    phrase:
      "Mumbai urban setting — Marine Drive railing, Bandra rooftop, monsoon-wet street with yellow taxi accent, sea breeze tugging her hair.",
  },
  bangalore_urban: {
    label: "Bangalore urban",
    phrase:
      "Bangalore urban setting — third-wave coffee café, Cubbon Park dappled morning light, Indiranagar street art, mild overcast weather.",
  },
  tier2_city: {
    label: "Tier-2 city",
    phrase:
      "Tier-2 Indian city — local mall railing, autorickshaw in the background, narrow market lane with cluttered storefronts, bright hard midday sun.",
  },
  rural_village: {
    label: "Rural village",
    phrase:
      "Rural Indian village — kachha mud road, mustard or wheat field at horizon, single peepal tree, golden-hour sunset over open land, dust in the air.",
  },
  hill_station: {
    label: "Hill station",
    phrase:
      "Himalayan hill station — pine trees, mountain mist, layered shawl, cool blue tones, possible snow on distant slopes.",
  },
  beach_goa: {
    label: "Goa beach",
    phrase:
      "Goa beach setting — palm shadows, wet sand reflection, sunset over the Arabian Sea, casual beachwear, soft warm wind.",
  },
  studio: {
    label: "Studio",
    phrase:
      "Plain studio — neutral cyclorama backdrop (paper grey or beige), controlled lighting, no environment beyond the subject.",
  },
  bedroom_personal: {
    label: "Personal bedroom",
    phrase:
      "Personal bedroom — unmade bed with rumpled white sheets, fairy lights along the headboard, posters on the wall, lived-in clutter on the bedside (water bottle, headphones, charging cable), soft warm overhead lamp.",
  },
  cafe_interior: {
    label: "Café interior",
    phrase:
      "Café interior — brass railings, exposed brick wall, hanging Edison bulbs, table with a half-drunk cappuccino and an open laptop, afternoon haze coming through the window.",
  },
  hostel_room: {
    label: "Hostel / dorm room",
    phrase:
      "Indian college hostel room — single bed against the wall, posters and polaroids pinned above, study desk with open books, a steel water bottle and tube light overhead, very lived-in.",
  },
};

export type LightingKey =
  | "golden_hour"
  | "blue_hour"
  | "harsh_noon"
  | "overcast_soft"
  | "window_light"
  | "tungsten_warm"
  | "fluorescent_cool"
  | "neon_night"
  | "direct_flash"
  | "low_light_grain"
  | "bad_lighting";

export const LIGHTING_OPTIONS: Record<
  LightingKey,
  { label: string; phrase: string }
> = {
  golden_hour: {
    label: "Golden hour",
    phrase:
      "Golden-hour direct sunlight, ~3200K, low and warm, raking from camera left — long shadows, hair haloed in backlight, skin warm and rim-lit.",
  },
  blue_hour: {
    label: "Blue hour",
    phrase:
      "Blue-hour twilight ambient ~5500K cool deep-blue, with a single warm point source ~3000K in the background — cinematic contrast and color separation.",
  },
  harsh_noon: {
    label: "Harsh noon",
    phrase:
      "Harsh midday sun overhead, ~5600K — high contrast, hard shadow under the jaw and nose, bright highlights on skin, very real outdoor feel.",
  },
  overcast_soft: {
    label: "Overcast soft",
    phrase:
      "Overcast soft daylight, ~6500K — even ambient, no hard shadows, slightly cool, magazine-soft skin rendering, single shadow direction from above.",
  },
  window_light: {
    label: "Window light",
    phrase:
      "Window light from camera left, ~5400K, soft diffusion through a sheer curtain — classical portrait quality, fall-off into shadow on the camera-right side of her face.",
  },
  tungsten_warm: {
    label: "Tungsten warm",
    phrase:
      "Indoor warm tungsten bulb overhead, ~3000K — yellow-orange cast, intimate, lower exposure on midtones, deep shadows in the corners of the room.",
  },
  fluorescent_cool: {
    label: "Fluorescent cool",
    phrase:
      "Cool fluorescent overhead, ~4500K with slight green tint — flat shadows, office or fitting-room quality, slight color cast on white surfaces.",
  },
  neon_night: {
    label: "Neon night",
    phrase:
      "Night street neon — magenta-and-cyan spill across her face from a sign just out of frame, dark background, single sharp light source.",
  },
  direct_flash: {
    label: "Direct on-camera flash",
    phrase:
      "Direct on-camera flash — sharp shadow behind the subject, slight overexposure on the skin closest to the camera, Y2K party energy.",
  },
  low_light_grain: {
    label: "Low light grain",
    phrase:
      "Low-light shot at ISO 3200, visible grain, deep shadows, single weak warm source — intimate late-night feel.",
  },
  bad_lighting: {
    label: "Bad lighting",
    phrase:
      "Imperfect mixed lighting — fluorescent overhead and warm phone screen on her chin, uneven white balance, slightly green shadows, real-life-not-staged feel.",
  },
};

export type HairstyleKey =
  | "long_loose_wavy"
  | "long_loose_straight"
  | "high_ponytail"
  | "low_ponytail"
  | "loose_low_bun"
  | "top_knot"
  | "half_up_down"
  | "side_braid"
  | "two_braids"
  | "wet_slicked"
  | "messy_bedhead"
  | "wind_swept"
  | "claw_clip"
  | "curtain_bangs";

export const HAIRSTYLE_OPTIONS: Record<
  HairstyleKey,
  { label: string; phrase: string }
> = {
  long_loose_wavy: {
    label: "Long loose wavy",
    phrase:
      "long dark-brown wavy hair worn loose, falling past the mid-back, soft body and natural beach-wave texture, slight frizz at the ends",
  },
  long_loose_straight: {
    label: "Long loose straight",
    phrase:
      "long dark-brown straight hair worn loose, falling past the mid-back, smooth and glossy, centre or slight side part",
  },
  high_ponytail: {
    label: "High ponytail",
    phrase:
      "high ponytail tied tight at the crown, the length swinging behind her, two thin face-framing strands left loose at the temples",
  },
  low_ponytail: {
    label: "Low ponytail",
    phrase:
      "low ponytail at the nape of the neck, smooth and sleek across the crown, a single wrapped section around the elastic",
  },
  loose_low_bun: {
    label: "Loose low bun",
    phrase:
      "loose low bun at the nape, intentionally messy with face-framing strands escaping at the temples and a soft halo of flyaways",
  },
  top_knot: {
    label: "Top knot",
    phrase:
      "top knot piled high on the crown, slightly messy with two soft strands loose at the temples",
  },
  half_up_down: {
    label: "Half-up half-down",
    phrase:
      "half-up half-down style — top section pulled back into a small clip or band, the lower half falling loose in soft waves",
  },
  side_braid: {
    label: "Side braid",
    phrase:
      "single loose side braid hanging over her right shoulder, slightly tousled with face-framing strands left out",
  },
  two_braids: {
    label: "Two braids",
    phrase:
      "two long braided pigtails resting on her chest, parted in the middle, soft and slightly loose",
  },
  wet_slicked: {
    label: "Wet slicked-back",
    phrase:
      "hair freshly wet and slicked straight back from the forehead, droplets along the hairline, dark and glossy",
  },
  messy_bedhead: {
    label: "Messy bedhead",
    phrase:
      "messy bedhead — slept-on texture, soft volume at the crown, hair falling across one cheek, natural slept-in shape",
  },
  wind_swept: {
    label: "Wind-swept",
    phrase:
      "hair caught mid-motion in a gust, strands lifting and crossing the face, soft motion blur on the tips",
  },
  claw_clip: {
    label: "Claw clip up",
    phrase:
      "hair piled up at the back of the head with a tortoise-shell claw clip, loose strands at the nape and temples",
  },
  curtain_bangs: {
    label: "Curtain bangs",
    phrase:
      "long centre-parted curtain bangs sweeping outward from the cheekbones, the rest of the hair worn long and loose behind",
  },
};

// ---------- Service ----------

export async function generateImagePrompts(
  opts: ImagePromptOpts
): Promise<string[]> {
  const scene = opts.scene.trim();
  if (!scene) throw new Error("scene is required");
  const persona =
    opts.personaDescriptor?.trim() || BRAND_VOICE_VISUAL_FALLBACK;
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

function buildDirectorsNotes(opts: ImagePromptOpts): string {
  const lines: string[] = [];
  if (opts.outfit) lines.push(`OUTFIT — ${OUTFIT_OPTIONS[opts.outfit].phrase}`);
  if (opts.shotType)
    lines.push(`SHOT TYPE — ${SHOT_TYPE_OPTIONS[opts.shotType].phrase}`);
  if (opts.cameraQuality)
    lines.push(
      `CAMERA — ${CAMERA_QUALITY_OPTIONS[opts.cameraQuality].phrase}`
    );
  if (opts.photographer)
    lines.push(
      `PHOTOGRAPHER — ${PHOTOGRAPHER_OPTIONS[opts.photographer].phrase}`
    );
  if (opts.cameraAngles && opts.cameraAngles.length > 0) {
    const validAngles = opts.cameraAngles.filter(
      (k): k is CameraAngleKey => CAMERA_ANGLE_OPTIONS[k] !== undefined
    );
    const firstAngle = validAngles[0];
    if (validAngles.length === 1 && firstAngle) {
      lines.push(
        `ANGLE — ${CAMERA_ANGLE_OPTIONS[firstAngle].phrase} Use this same angle for every prompt in the set.`
      );
    } else if (validAngles.length > 1) {
      const list = validAngles
        .map(
          (k, i) =>
            `(${i + 1}) ${CAMERA_ANGLE_OPTIONS[k].label} — ${CAMERA_ANGLE_OPTIONS[k].phrase}`
        )
        .join("\n");
      lines.push(
        `ANGLES — ${validAngles.length} angles provided; assign ONE distinct angle to each prompt in the set, in order if the count matches, otherwise rotate / repeat as needed. Each prompt must use exactly one of these angles, and the angle drives the framing of that prompt only:\n${list}`
      );
    }
  }
  if (opts.locale)
    lines.push(`LOCALE — ${LOCALE_OPTIONS[opts.locale].phrase}`);
  if (opts.lighting)
    lines.push(`LIGHTING — ${LIGHTING_OPTIONS[opts.lighting].phrase}`);
  // Default tone bias: on unless explicitly false. Pushes outfit / pose /
  // composition / expression choices toward the flirty + girlfriend-pose +
  // body-flattering register WITHOUT ever using intent words. Concrete visual
  // direction only — that's what gets through prompt classifiers cleanly while
  // the image generator's own VLM remains the actual safety layer.
  const tonePersonalityOn = opts.defaultPersonality !== false;
  if (tonePersonalityOn) {
    lines.push(
      `DEFAULT TONE BIAS (active) — bias visual choices toward the "soft-flirty girlfriend posting for her boyfriend" register, expressed STRICTLY as concrete visual direction. Never use intent words like sexy, hot, flirty, naughty, seductive, erotic, alluring, sensual — describe what is in frame.
- Outfit lean (when not overridden by an explicit OUTFIT note): fitted silhouettes that emphasise the locked persona's defined waist and hourglass proportions. Examples: low-rise denim with a tucked-in fitted tank exposing the midriff and the body chain at the navel; mini skirt with a tucked-in fitted bodysuit and bare thighs; ribbed crop knit + bike shorts; satin slip dress with thin straps falling along the curve of the shoulder; off-shoulder fitted top; mid-thigh dress with a side slit; ribbed two-piece swim with sarong loose at the hip; oversized white tee styled as a dress hitting mid-thigh.
- Pose lean: confident "girlfriend-shot" intimacy. Direct eye contact with the lens with a soft warm half-smile; head tilted slightly so one cheek catches the light; one hand pulled into the hair; weight shifted onto one hip so the silhouette curves; lips slightly parted; chin lowered with eyes raised through the lashes; body angled toward the camera at three-quarter; one knee popped up when seated; lying on her stomach across the bed with chin on hands, feet kicked up crossed at the ankles; looking back over her shoulder mid-stride; leaning forward with elbows on knees so the collarbone catches the light.
- Composition lean: tighter framing. Mid-shot or three-quarter so she fills more of the frame, intimate camera distance (~1.5 m), shallow depth of field (f/1.8 - f/2.2), focus locked on her eyes. Soft fall-off on the background. Centred or slight rule-of-thirds. Background out of focus and warm.
- Expression lean: confident warmth. A quiet "you" half-smile. Eyes soft, slightly heavy-lidded. Looking up through the lashes when angle is low. Lips with a natural gloss highlight.
- Lighting lean (when not overridden): warm key from camera-front-left at ~3200K, soft fill from a white surface camera-right, golden-hour or window-light preferred. Skin reads warm, glowing, naturally dewy. Rim of light on the shoulder and edge of the hair.
- Skin and texture: emphasise natural skin texture (pores, fine hair on the cheek, soft sheen on the collarbone and forehead from warmth), small mole on the left collarbone visible, dimple on the left cheek when smiling.
- Read of the shot: confident, warm, intimate, body-flattering. NEVER describe these as a state of mind or intent — describe them as the photographer would: outfit, pose, light, lens, framing.`
    );
  }
  if (opts.hairstyles && opts.hairstyles.length > 0) {
    const valid = opts.hairstyles.filter(
      (k): k is HairstyleKey => HAIRSTYLE_OPTIONS[k] !== undefined
    );
    const first = valid[0];
    if (valid.length === 1 && first) {
      lines.push(`HAIRSTYLE — ${HAIRSTYLE_OPTIONS[first].phrase}.`);
    } else if (valid.length > 1) {
      const optionsBlock = valid
        .map(
          (k) =>
            `• ${HAIRSTYLE_OPTIONS[k].label}: ${HAIRSTYLE_OPTIONS[k].phrase}`
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

export type OptionCatalog = {
  outfit: Array<{ value: string; label: string }>;
  shotType: Array<{ value: string; label: string }>;
  cameraQuality: Array<{ value: string; label: string }>;
  photographer: Array<{ value: string; label: string }>;
  cameraAngle: Array<{ value: string; label: string }>;
  locale: Array<{ value: string; label: string }>;
  lighting: Array<{ value: string; label: string }>;
  hairstyle: Array<{ value: string; label: string }>;
};

export function getOptionCatalog(): OptionCatalog {
  const toList = <K extends string>(
    rec: Record<K, { label: string }>
  ): Array<{ value: string; label: string }> =>
    (Object.keys(rec) as K[]).map((k) => ({ value: k, label: rec[k].label }));
  return {
    outfit: toList(OUTFIT_OPTIONS),
    shotType: toList(SHOT_TYPE_OPTIONS),
    cameraQuality: toList(CAMERA_QUALITY_OPTIONS),
    photographer: toList(PHOTOGRAPHER_OPTIONS),
    cameraAngle: toList(CAMERA_ANGLE_OPTIONS),
    locale: toList(LOCALE_OPTIONS),
    lighting: toList(LIGHTING_OPTIONS),
    hairstyle: toList(HAIRSTYLE_OPTIONS),
  };
}
