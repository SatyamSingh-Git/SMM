import { prisma } from "@smm/db";
import { getConfig } from "./runtime-config.js";
import { writeCached, type CachedAiPayload } from "./dashboard-cache.js";
import { parseLooseJson } from "./llm-json.js";

// Take the most recent comments + ask DeepSeek to bucket them by sentiment
// AND extract the actual topics people keep asking about. The topic side
// is the real value — surfaces content gaps ("47% are asking about your
// skincare routine — post one and it'll print").

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const CACHE_KIND = "commentThemes";

export type SentimentBucket = {
  label: string; // e.g. "Flirty / horny", "Curious", "Compliment", "Spam", "Negative", "Question"
  count: number;
  examples: string[]; // up to 3 verbatim comments
};

export type TopicCluster = {
  theme: string;     // 1-4 word topic, e.g. "Skincare routine"
  count: number;
  examples: string[];
  contentIdea: string; // 1-line action: what content would directly answer this
};

export type CommentThemesPayload = {
  totalAnalyzed: number;
  sentimentBreakdown: SentimentBucket[];
  topicClusters: TopicCluster[];
  insight: string; // 1-2 sentence "so what" summary
};

export type CommentThemesResult = CachedAiPayload<CommentThemesPayload>;

const SYSTEM_PROMPT = `You are an audience analyst for @cute_aisha_vibes — a young Indian female creator on Threads/Instagram. Audience: young Indian males 18-25.

You'll be given recent comments from her posts. Your job:
1. Bucket them by sentiment (Flirty / Compliment / Question / Curious / Spam-or-promo / Negative / Other).
2. Cluster the QUESTIONS and curious comments by topic (e.g. "Skincare routine", "Where she lives", "Outfit source", "Dance steps").
3. For each topic cluster, write a one-line content idea that would directly answer the topic.
4. End with a 1-2 sentence "so what" — the single most actionable takeaway.

Output STRICT JSON:
{
  "sentimentBreakdown": [{ "label": "...", "count": N, "examples": ["...", "..."] }, ...],
  "topicClusters": [{ "theme": "...", "count": N, "examples": ["..."], "contentIdea": "..." }, ...],
  "insight": "..."
}

Rules:
- 4-7 sentiment buckets covering all comments.
- 3-7 topic clusters. Only include clusters with ≥2 comments — singletons aren't patterns.
- Examples should be the actual verbatim comment text, truncated to 80 chars max.
- contentIdea should be SPECIFIC (e.g. "Reel walkthrough of evening skincare with product names" not "post about beauty").
- If there's barely any data, say so honestly in insight.
- JSON only.`;

export async function generateCommentThemes(): Promise<CommentThemesPayload> {
  if (!getConfig().deepseekApiKey) throw new Error("DEEPSEEK_API_KEY not configured");

  // Most-recent ~300 non-spam-status comments — caps token cost at ~4-5K input.
  const rows = await prisma.engagementComment.findMany({
    where: { platform: "threads" },
    orderBy: { receivedAt: "desc" },
    take: 250,
    select: { text: true, authorUsername: true },
  });

  if (rows.length === 0) {
    return {
      totalAnalyzed: 0,
      sentimentBreakdown: [],
      topicClusters: [],
      insight: "No comments to analyze yet. Try posting and come back when comments start rolling in.",
    };
  }

  const commentsBlock = rows
    .map(
      (r, i) =>
        `${i + 1}. ${r.authorUsername ? "@" + r.authorUsername + ": " : ""}${truncate(r.text, 160)}`
    )
    .join("\n");

  const userMsg = `Analyze these ${rows.length} recent comments:\n\n${commentsBlock}\n\nReturn JSON.`;

  const callDeepseek = async (
    jsonMode: boolean
  ): Promise<{ content: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> => {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${getConfig().deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: getConfig().deepseekModel,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
        temperature: 0.4,
        max_tokens: 3000,
        // deepseek-v4-flash is a thinking model — left on, it burns the entire
        // token budget on hidden reasoning and returns empty/truncated JSON.
        // Disable thinking for this structured extraction task.
        thinking: { type: "disabled" },
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      content: (data.choices?.[0]?.message?.content ?? "").trim(),
      usage: data.usage,
    };
  };

  type Parsed = Omit<CommentThemesPayload, "totalAnalyzed">;
  let resp = await callDeepseek(true);
  let parsed = parseLooseJson<Parsed>(resp.content);
  if (!parsed) {
    // DeepSeek sometimes returns empty/truncated on heavy emoji+Devanagari
    // input. Retry once without JSON mode; the loose parser handles fences/prose.
    resp = await callDeepseek(false);
    parsed = parseLooseJson<Parsed>(resp.content);
  }

  if (!parsed) {
    // Never 500. Cache an empty result with a retry hint so the card shows a
    // clear state instead of silently failing during Sync.
    const fallback: CommentThemesPayload = {
      totalAnalyzed: rows.length,
      sentimentBreakdown: [],
      topicClusters: [],
      insight: `Found ${rows.length} comments but the analyzer returned an unreadable response this time. Hit ↻ to try again.`,
    };
    await writeCached<CommentThemesPayload>(CACHE_KIND, fallback);
    return fallback;
  }

  const out: CommentThemesPayload = {
    totalAnalyzed: rows.length,
    sentimentBreakdown: Array.isArray(parsed.sentimentBreakdown) ? parsed.sentimentBreakdown : [],
    topicClusters: Array.isArray(parsed.topicClusters) ? parsed.topicClusters : [],
    insight: parsed.insight ?? "",
  };

  await writeCached<CommentThemesPayload>(CACHE_KIND, out, {
    input: resp.usage?.prompt_tokens,
    output: resp.usage?.completion_tokens,
  });
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export { CACHE_KIND as commentThemesCacheKind };
