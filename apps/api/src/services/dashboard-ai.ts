import type { Platform } from "@smm/db";
import { getConfig } from "./runtime-config.js";
import { systemPromptFor } from "./prompt/system.js";
import {
  getKpis,
  getRecentPostsWithLatestInsight,
  getTypeBreakdown,
} from "./dashboard-analytics.js";
import { thinkingJson } from "./deepseek.js";

// Asks DeepSeek to be a creator strategist. Inputs: real numbers from the
// user's posts. Output: structured insights the dashboard renders directly
// (wins / warnings / try-next / weeklyFocus + scorecard).
// Thinking is ON here — reasoning measurably improves insight quality — with a
// retry loop (see deepseek.ts) to absorb v4-flash's occasional runaway-empty.

export type WinOrWarn = {
  title: string;
  detail: string;
  evidence?: string;
};

export type TryNextIdea = {
  title: string;
  why: string;
  // optional concrete prompt the user can use in compose
  exampleCaption?: string;
};

export type ScoreCard = {
  consistency: { grade: "A" | "B" | "C" | "D"; note: string };
  engagement: { grade: "A" | "B" | "C" | "D"; note: string };
  growth: { grade: "A" | "B" | "C" | "D"; note: string };
};

export type DashboardAiInsights = {
  weeklyFocus: string;
  wins: WinOrWarn[];
  warnings: WinOrWarn[];
  tryNext: TryNextIdea[];
  scoreCard: ScoreCard;
  generatedAt: string;
  // Echoes a few inputs so the UI can show "based on X posts, Y days of data".
  basedOn: {
    postsAnalyzed: number;
    daysOfData: number;
  };
};

export const SYSTEM_PROMPT = `You are a content strategist for the creator — a young Indian female fashion / cute / dance / vibes creator on Instagram + Threads.

Audience: young Indian males 18-25. Goal: replies, saves, shares, profile visits, viral reach.

You'll get raw performance numbers. Output a JSON object the dashboard renders directly. Be SPECIFIC — reference actual post captions and numbers when you can. Don't write generic creator advice; write what HER data shows.

Tone:
- Direct, no fluff
- Honest about what's not working
- Actionable (every suggestion is something she can do next post)
- Niche-aware (Indian-creator context — Reels > stills for reach, OOTD always wins, late-night posts perform for male audiences, hashtag strategy, monsoon/festival hooks, etc.)

Output JSON schema (STRICT):
{
  "weeklyFocus": "ONE sentence — the single most important thing for the week.",
  "wins": [
    { "title": "short bold title", "detail": "1-2 sentences why it worked", "evidence": "specific post or number" }
  ],
  "warnings": [
    { "title": "...", "detail": "...", "evidence": "..." }
  ],
  "tryNext": [
    { "title": "concrete idea", "why": "based on her data", "exampleCaption": "optional draft caption (Hinglish, her voice)" }
  ],
  "scoreCard": {
    "consistency": { "grade": "A|B|C|D", "note": "one-line explanation" },
    "engagement":  { "grade": "A|B|C|D", "note": "..." },
    "growth":      { "grade": "A|B|C|D", "note": "..." }
  }
}

Rules:
- 2-4 wins, 2-4 warnings, 3-5 tryNext.
- If she has very little data (< 5 posts with insights), say so honestly in the weeklyFocus and base tryNext on niche-general best practices.
- exampleCaption should match the creator's voice (Hinglish-ish, 1-3 emojis from 🤭😉😜🥰🩷🎀💕✨😭💀👀, "main character" energy).

DATA HONESTY — CRITICAL:
- Meta does NOT expose historical follower counts. We only know the CURRENT follower number; deltas come from our own daily snapshots. If "followers.delta14d" is null, we DON'T have 14 days of follower history yet — DO NOT claim "zero growth" or "no new followers." Instead, in that case, say "follower trend tracking has just started; need a week of data before I can call this."
- If "followers.historyDays" is small (e.g. < 7), be explicit: "we've been tracking follower count for X days, not enough to comment on growth trajectory yet."
- Never invent numbers. If a metric is missing/null, just say "data not available yet" rather than treating it as 0.

- No markdown. No explanations outside JSON.`;

export async function generateAiInsights(
  platform?: Platform
): Promise<DashboardAiInsights> {
  if (!getConfig().deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY not configured");
  }
  const days = 30;
  const kpis = await getKpis({ platform });
  const top = (await getRecentPostsWithLatestInsight({ days, limit: 25, platform }))
    .filter((p) => p.reach || p.views || p.likes)
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 15);
  const types = await getTypeBreakdown(days, platform);
  const scope = platform
    ? platform === "instagram"
      ? "Instagram"
      : "Threads"
    : "all platforms (Instagram + Threads)";

  const inputJson = JSON.stringify(
    {
      followers: {
        current: kpis.followers.current,
        delta14d: kpis.followers.delta14d, // null if not enough history
        historyDays: kpis.followers.historyDays,
        // Explicit flag for the LLM so it doesn't have to infer the meaning of null.
        deltaAvailable: kpis.followers.delta14d !== null,
      },
      reach7d: kpis.reach7d,
      engagementRate: kpis.engagementRate,
      postsPublished7d: kpis.postsPublished7d,
      repliesHandled: kpis.repliesHandled,
      typeBreakdown: types,
      topPosts: top.map((p) => ({
        platform: p.platform,
        type: p.type,
        publishedAt: p.publishedAt?.toISOString(),
        caption: p.caption?.slice(0, 220),
        reach: p.reach,
        views: p.views,
        likes: p.likes,
        comments: p.comments,
        saves: p.saves,
        shares: p.shares,
        engagement: p.engagement,
      })),
    },
    null,
    2
  );

  const userMsg = `Here's the creator's ${scope} performance over the last ${days} days:

${inputJson}
${
  platform
    ? `\nIMPORTANT: These numbers are for ${scope} ONLY. Every win, warning, score, and idea must be about ${scope}. Do NOT mention, compare to, or reference the other platform — this card is ${scope}-only.`
    : ""
}
Now generate the dashboard insights JSON.`;

  const result = await thinkingJson<Partial<DashboardAiInsights>>({
    messages: [
      { role: "system", content: systemPromptFor("dashboardStrategist") },
      { role: "user", content: userMsg },
    ],
    temperature: 0.7,
  });

  if (!result) {
    // Every thinking attempt ran away — don't 500, return a clear retry state.
    return {
      weeklyFocus:
        "Couldn't generate insights this round — the model spent its budget reasoning. Hit ↻ to try again.",
      wins: [],
      warnings: [],
      tryNext: [],
      scoreCard: {
        consistency: { grade: "C", note: "Hit ↻ to generate." },
        engagement: { grade: "C", note: "Hit ↻ to generate." },
        growth: { grade: "C", note: "Hit ↻ to generate." },
      },
      generatedAt: new Date().toISOString(),
      basedOn: { postsAnalyzed: top.length, daysOfData: days },
    };
  }

  const parsed = result.parsed;
  return {
    weeklyFocus: parsed.weeklyFocus ?? "Not enough data yet — keep posting and checking back daily.",
    wins: Array.isArray(parsed.wins) ? parsed.wins.slice(0, 5) : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 5) : [],
    tryNext: Array.isArray(parsed.tryNext) ? parsed.tryNext.slice(0, 6) : [],
    scoreCard:
      parsed.scoreCard ?? {
        consistency: { grade: "C", note: "Not enough data to grade yet." },
        engagement: { grade: "C", note: "Not enough data to grade yet." },
        growth: { grade: "C", note: "Not enough data to grade yet." },
      },
    generatedAt: new Date().toISOString(),
    basedOn: { postsAnalyzed: top.length, daysOfData: days },
  };
}
