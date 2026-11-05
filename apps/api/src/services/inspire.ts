// "What to Write" — inspiration mode.
//
// You feed in SOMEONE ELSE'S post (their text and/or image). We use it ONLY as
// a spark and write BRAND-NEW posts in the creator's own voice, reusing the
// exact same pipeline the caption assistant already uses:
//   describeImage()  -> OpenRouter / Qwen3-VL vision (optional, if image given)
//   deepseekChat()   -> DeepSeek writer with the profile's caption voice
//
// This file adds NOTHING to the existing caption flow — it only imports the
// already-exported helpers from ai.ts and feeds them a different prompt.

import { getConfig } from "./runtime-config.js";
import { systemPromptFor } from "./prompt/system.js";
import {
  deepseekChat,
  describeImage,
  type CaptionSuggestion,
  type LanguageMix,
} from "./ai.js";

export type InspireOpts = {
  platform: "instagram" | "threads";
  // The other post's caption/text (optional).
  sourceText?: string;
  // The other post's image as a public HTTPS URL (optional).
  imageUrl?: string;
  voices?: string[];
  languageMix?: LanguageMix;
  count?: number;
};

export async function inspireFromPost(
  opts: InspireOpts
): Promise<CaptionSuggestion[]> {
  const srcText = opts.sourceText?.trim();
  if (!srcText && !opts.imageUrl) {
    throw new Error("inspireFromPost needs sourceText, imageUrl, or both");
  }

  const n = opts.count ?? 4;
  const maxChars = opts.platform === "threads" ? 500 : 2200;
  const platformNote =
    opts.platform === "threads"
      ? "Threads — no hashtags, conversational, hook-first, one-line punchlines preferred."
      : "Instagram — short caption ok, include 8-15 hashtags array.";
  const voiceList =
    opts.voices && opts.voices.length > 0
      ? opts.voices.join(", ")
      : "playful + cute (default)";
  const langMix: LanguageMix = opts.languageMix ?? "english";

  // Reuse the SAME vision describer as the caption assistant — only when we
  // have an image AND OpenRouter is configured. A vision failure is non-fatal:
  // we still write from the pasted text alone.
  let imageDescription: string | null = null;
  if (opts.imageUrl && getConfig().openrouterApiKey) {
    try {
      imageDescription = await describeImage(opts.imageUrl);
    } catch (e) {
      console.warn(
        "[inspire] vision describe failed, using text only:",
        (e as Error).message
      );
    }
  }

  const inspirationBlock = [
    srcText ? `Their caption / text:\n"""${srcText.replace(/"""/g, '\\"\\"\\"')}"""` : null,
    imageDescription
      ? `Their image (described by a vision model):\n"""${imageDescription.trim()}"""`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const userText = `MODE: inspiration / "what should I write".
Below is SOMEONE ELSE'S post (NOT yours). Use it ONLY as a spark — borrow the topic, angle, or vibe. Then write BRAND-NEW posts in YOUR OWN voice riding the same theme.

HARD RULES for this mode:
- Do NOT copy their wording or structure. Reinterpret it as yourself.
- Do NOT @ them, reply to them, or reference "this post" / "the post above".
- Each result must read as an ORIGINAL post by the creator, not a remix caption.

${inspirationBlock}

Generate ${n} DISTINCT posts inspired by the above — different shapes/angles, all on-brand.

LANGUAGE MIX: ${langMix}
VOICE MODIFIERS to blend: ${voiceList}
Platform: ${platformNote}
Each caption ≤ ${maxChars} characters.

Return STRICT JSON:
{"suggestions":[{"caption":"...","hashtags":["..."]}]}`;

  const raw = await deepseekChat({
    messages: [
      { role: "system", content: systemPromptFor("caption") },
      { role: "user", content: userText },
    ],
    temperature: 0.95,
    maxTokens: 1500,
    jsonMode: true,
    cacheLabel: "inspire",
  });

  let parsed: { suggestions?: CaptionSuggestion[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "");
    parsed = JSON.parse(stripped);
  }
  const out = parsed.suggestions ?? [];
  return out.map((s) => ({
    caption: (s.caption ?? "").slice(0, maxChars),
    hashtags:
      opts.platform === "threads"
        ? []
        : Array.isArray(s.hashtags)
          ? s.hashtags.filter((h) => typeof h === "string").slice(0, 20)
          : [],
  }));
}
