import { PLATFORM_RULES, type PostType } from "@smm/shared";

// Caption-only lint. Soft, deterministic, zero-LLM warnings for patterns that
// hurt reach on Instagram/Threads CAPTIONS specifically.
//
// IMPORTANT: This is for CAPTIONS ONLY. Do NOT run it on auto-replies (which
// intentionally stack emojis and use Hinglish address) or on image-prompt scene
// text (different domain entirely). Captions are the one surface where these
// patterns are penalized.

export type CaptionWarning = {
  kind: "corporate" | "bait" | "emoji-clump";
  message: string;
};

// Marketing/corporate words that read as "brand intern", not a real creator.
const CORPORATE = [
  "elevate",
  "unlock",
  "leverage",
  "curated",
  "seamless",
  "empower",
  "unleash",
  "elevate your",
  "level up",
  "game-changer",
  "game changer",
  "must-have",
  "obsessed with bringing",
];

// Engagement-bait phrases Meta documents as down-ranked.
const BAIT = [
  "comment yes",
  "comment below",
  "tag a friend",
  "tag someone",
  "double tap if",
  "like if you",
  "save this post",
  "share this with",
  "follow for more",
  "link in bio for",
  "drop a",
];

export function lintCaption(text: string): CaptionWarning[] {
  const warnings: CaptionWarning[] = [];
  if (!text || !text.trim()) return warnings;
  const lower = text.toLowerCase();

  for (const w of CORPORATE) {
    if (lower.includes(w)) {
      warnings.push({
        kind: "corporate",
        message: `"${w}" reads as marketing copy — try how she'd actually say it`,
      });
      break; // one corporate warning is enough; don't pile on
    }
  }

  for (const b of BAIT) {
    if (lower.includes(b)) {
      warnings.push({
        kind: "bait",
        message: `"${b}" is engagement-bait — Meta down-ranks these`,
      });
      break;
    }
  }

  // End-stacked emoji clump: 4+ emojis all bunched at the very end reads as
  // chatbot output. (The brand voice distributes emojis through the line.)
  const emojiRun = text.match(/(\p{Extended_Pictographic}\s*){4,}\s*$/u);
  if (emojiRun) {
    warnings.push({
      kind: "emoji-clump",
      message: "emojis stacked at the end read as generated — spread them through the line",
    });
  }

  return warnings;
}

// Deterministic hook check for the first line (no LLM). Returns badges, not a
// score, so it never pushes the caption toward marketing polish.
export type HookBadge = { tone: "good" | "warn"; label: string };

export function checkHook(text: string, postType: string): HookBadge[] {
  const firstLine = (text.split("\n")[0] ?? "").trim();
  if (!firstLine) return [];
  const badges: HookBadge[] = [];

  // The cutoff is what most viewers see before "more" — read from the shared
  // platform table so the composer, the API and this agree by construction
  // rather than by everyone remembering the same number.
  const cutoff = PLATFORM_RULES[postType as PostType]?.hookCutoff ?? 0;
  if (cutoff > 0) {
    if (firstLine.length <= cutoff) {
      badges.push({ tone: "good", label: `hook fits (${firstLine.length}/${cutoff})` });
    } else {
      badges.push({ tone: "warn", label: `hook past the fold (${firstLine.length}/${cutoff})` });
    }
  }

  // Bait phrase right in the hook is the worst place for it.
  const lower = firstLine.toLowerCase();
  if (BAIT.some((b) => lower.includes(b))) {
    badges.push({ tone: "warn", label: "bait phrase in hook" });
  }

  return badges;
}
