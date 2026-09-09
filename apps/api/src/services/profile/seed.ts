// The seed profile: the constants that used to be hardcoded, turned into data.
//
// Deliberately built by IMPORTING the existing constants rather than by
// re-typing them. Two reasons: transcribing a 200-line prompt by hand is a
// silent-corruption risk, and while both forms exist there must be exactly one
// copy of the text. Once the DB row is seeded the row is the source of truth;
// these imports remain only as the factory default.
//
// The handle is substituted OUT into a {{handle}} placeholder so that renaming
// the account in Settings updates every prompt at once, instead of leaving the
// old handle buried in five prose blocks.

import { BRAND_VOICE, BRAND_VOICE_VISUAL_FALLBACK } from "../ai.js";
import { SYSTEM_PROMPT as REPLY_PROMPT } from "../reply-generator.js";
import { SYSTEM_PROMPT as STRATEGIST_PROMPT } from "../dashboard-ai.js";
import { SYSTEM_PROMPT as CAPTION_ANALYST_PROMPT } from "../dashboard-caption-patterns.js";
import { SYSTEM_PROMPT as COMMENT_ANALYST_PROMPT } from "../dashboard-comment-themes.js";
import { DEFAULT_CADENCE, type Profile } from "./types.js";

/** The handle baked into the original constants, replaced by a placeholder. */
const SEED_HANDLE = "cute_aisha_vibes";

/** Replace every literal occurrence of the seed handle with {{handle}}. */
export function templatize(text: string, handle: string = SEED_HANDLE): string {
  return text.split(handle).join("{{handle}}");
}

export function seedProfile(): Profile {
  return {
    id: "default",
    name: "Default",
    version: 1,
    identity: {
      handle: SEED_HANDLE,
      displayName: "",
      pronouns: "she/her",
      ageBand: "19-21",
      nationality: "Indian",
      locale: "IN",
      languages: ["English", "Hindi", "Hinglish"],
      niche: "fashion / cute / dance / vibes",
      audience: "young Indian males 18-25",
    },
    voice: {
      caption: templatize(BRAND_VOICE),
      reply: templatize(REPLY_PROMPT),
      dashboardStrategist: templatize(STRATEGIST_PROMPT),
      dashboardCaptionAnalyst: templatize(CAPTION_ANALYST_PROMPT),
      dashboardCommentAnalyst: templatize(COMMENT_ANALYST_PROMPT),
    },
    visual: {
      subjectDescriptor: templatize(BRAND_VOICE_VISUAL_FALLBACK),
    },
    cadence: DEFAULT_CADENCE,
    policy: {
      // Today's effective behaviour, written down. Publishing and replying
      // already run unattended; nothing else exists yet. Phase 3 puts the gate
      // in front of these, Phase 8 promotes the rest.
      autonomy: {
        plan: "off",
        generate_media: "off",
        write_caption: "off",
        schedule: "off",
        publish: "auto",
        reply: "auto",
        learn: "auto",
      },
    },
  };
}
