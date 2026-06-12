import type { Platform } from "@smm/db";
import { getConfig } from "./runtime-config.js";
import { getRecentPostsWithLatestInsight } from "./dashboard-analytics.js";
import { writeCached, type CachedAiPayload } from "./dashboard-cache.js";
import { thinkingJson } from "./deepseek.js";

// Feed the top 10 and bottom 10 posts to DeepSeek and ask it to extract
// what makes the top ones top. Concrete pattern detection — hook structure,
// emoji usage, length, opening words, voice. Thinking is ON (recommendations
// are better with reasoning); thinkingJson retries to absorb runaway-empty.

const CACHE_KIND = "captionPatterns";

// Per-platform cache key. Omit platform → the legacy "all platforms" key.
export function captionPatternsKind(platform?: Platform): string {
  return platform ? `captionPatterns:${platform}` : CACHE_KIND;
}

export type CaptionPatternObservation = {
  title: string; // "Posts opening with a question win"
  detail: string; // 1-2 sentences why / how strong the pattern is
  evidence: string; // specific examples from the data
};

export type CaptionPatternsPayload = {
  doMore: CaptionPatternObservation[];
  doLess: CaptionPatternObservation[];
  // Concrete pattern that the user can copy literally into their next caption.
  templateExamples: string[];
  // How many posts the analyzer found with insight metrics. 0 = nothing to analyze.
  postsAnalyzed: number;
  // Human-readable note shown when the section can't render the usual breakdown
  // (e.g. "0 posts with insight data — run Sync first").
  note?: string;
};

export type CaptionPatternsResult = CachedAiPayload<CaptionPatternsPayload>;

const SYSTEM_PROMPT = `You're a content analyst for @cute_aisha_vibes — a young Indian female creator (fashion / cute / dance, Threads + Instagram). You'll get her top-engaging and bottom-engaging posts side by side.

Your job: extract CONCRETE patterns the user can act on next post. Not vague advice. Real observations.

Look for:
- Hook structure (question vs statement vs POV vs ">>>>")
- Emoji choice + count + placement
- Caption length (short / medium / long)
- Opening word patterns (first 5 words)
- Voice (cute / flirty / playful / bold / mysterious)
- Topic (OOTD, dance, mood, observation, "boys are like")
- Hashtag presence + count
- Platform difference (does the same caption style work on both?)

Output STRICT JSON:
{
  "doMore": [{ "title": "short bold observation", "detail": "1-2 sentences", "evidence": "specific examples" }, ...],
  "doLess": [{ "title": "...", "detail": "...", "evidence": "..." }, ...],
  "templateExamples": [
    "<caption template the user could literally use, in her voice>",
    "..."
  ]
}

Rules:
- 3-5 doMore, 2-3 doLess.
- 3 templateExamples — each a concrete caption draft she could paste into compose right now.
- Be SPECIFIC. "Use questions" is weak. "Open with 'Boys honestly...' — your top 4 captions all do that and avg 3.2x more engagement" is good.
- If data is thin (<6 posts in either bucket), say so in detail and base patterns on niche knowledge.
- JSON only, no markdown.`;

export async function generateCaptionPatterns(
  platform?: Platform
): Promise<CaptionPatternsPayload> {
  if (!getConfig().deepseekApiKey) throw new Error("DEEPSEEK_API_KEY not configured");

  const cacheKind = captionPatternsKind(platform);
  const scope = platform
    ? platform === "instagram"
      ? "Instagram"
      : "Threads"
    : "all platforms";

  const posts = await getRecentPostsWithLatestInsight({ days: 30, limit: 100, platform });
  const withMetrics = posts.filter((p) => p.likes != null || p.views != null || p.reach != null);

  if (withMetrics.length === 0) {
    const empty: CaptionPatternsPayload = {
      doMore: [],
      doLess: [],
      templateExamples: [],
      postsAnalyzed: 0,
      note:
        posts.length === 0
          ? `No published ${scope} posts in the last 30 days. Backfill from Meta or post something to start the analysis.`
          : `Found ${posts.length} recent ${scope} posts but none have insight metrics yet. Click "Sync now" at the top of the dashboard to pull Meta Insights — that powers this analysis.`,
    };
    await writeCached(cacheKind, empty);
    return empty;
  }

  // Sort by engagement, take top 10 and bottom 10.
  const sorted = withMetrics.slice().sort((a, b) => b.engagement - a.engagement);
  const top = sorted.slice(0, 10);
  const bottom = sorted.slice(-10).reverse();

  const summarize = (p: (typeof posts)[number]) =>
    `[${p.platform}/${p.type}] eng=${p.engagement} reach=${p.reach ?? p.views ?? "?"} likes=${p.likes ?? "?"} | ${(p.caption ?? "").slice(0, 240).replace(/\n+/g, " ")}`;

  const userMsg = `These are ${scope} posts ONLY. Analyze patterns for ${scope}.

TOP 10 (by engagement):
${top.map((p, i) => `${i + 1}. ${summarize(p)}`).join("\n")}

BOTTOM 10:
${bottom.map((p, i) => `${i + 1}. ${summarize(p)}`).join("\n")}

Generate the pattern analysis as JSON.`;

  // Thinking ON — pattern extraction (recommendations) is better with
  // reasoning. thinkingJson retries to absorb v4-flash's runaway-empty.
  const result = await thinkingJson<CaptionPatternsPayload>({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ],
    temperature: 0.5,
  });

  if (!result) {
    // Every thinking attempt ran away — cache an empty result with a retry hint.
    const fallback: CaptionPatternsPayload = {
      doMore: [],
      doLess: [],
      templateExamples: [],
      postsAnalyzed: withMetrics.length,
      note: `Analyzed ${withMetrics.length} ${scope} posts but the model ran out of budget reasoning. Hit ↻ to try again.`,
    };
    await writeCached(cacheKind, fallback);
    return fallback;
  }

  const parsed = result.parsed;
  const out: CaptionPatternsPayload = {
    doMore: Array.isArray(parsed.doMore) ? parsed.doMore : [],
    doLess: Array.isArray(parsed.doLess) ? parsed.doLess : [],
    templateExamples: Array.isArray(parsed.templateExamples) ? parsed.templateExamples : [],
    postsAnalyzed: withMetrics.length,
  };
  await writeCached(cacheKind, out, {
    input: result.usage?.prompt_tokens,
    output: result.usage?.completion_tokens,
  });
  return out;
}

export { CACHE_KIND as captionPatternsCacheKind };
