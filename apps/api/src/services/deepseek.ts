import { env } from "../env.js";
import { parseLooseJson } from "./llm-json.js";

// Shared DeepSeek chat client.
//
// deepseek-v4-flash is a *thinking* model:
//  - thinking ON  → better reasoning, used for insights/recommendations. BUT it
//    sometimes runs away and spends the entire token budget on hidden reasoning,
//    returning empty/truncated output. The API ignores any thinking budget cap
//    (max_thinking_tokens / reasoning_effort), so the only mitigation is to
//    retry — each call is ~50/50, so a few attempts reliably lands a good one.
//  - thinking OFF → deterministic, fast, cheap. Right for extraction / short
//    tasks (comment bucketing, replies, caption assist). Those call the model
//    directly with `thinking: { type: "disabled" }`.

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

export type DeepseekMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type DeepseekUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

async function chatRaw(opts: {
  messages: DeepseekMessage[];
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  jsonMode?: boolean;
}): Promise<{ content: string; usage?: DeepseekUsage }> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not configured");
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      // Default (no param) = thinking on. Explicitly disable when off.
      ...(opts.thinking ? {} : { thinking: { type: "disabled" } }),
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: DeepseekUsage;
  };
  return {
    content: (data.choices?.[0]?.message?.content ?? "").trim(),
    usage: data.usage,
  };
}

/**
 * Generate JSON with thinking ON, retrying when the model runs away on
 * reasoning and returns empty/unparseable output. Returns the parsed payload
 * + token usage from the successful call, or null if every attempt failed.
 */
export async function thinkingJson<T>(opts: {
  messages: DeepseekMessage[];
  temperature: number;
  maxTokens?: number;
  attempts?: number;
}): Promise<{ parsed: T; usage?: DeepseekUsage } | null> {
  // Generous budget so a non-runaway thinking pass has room for both the
  // reasoning and the JSON answer.
  const maxTokens = opts.maxTokens ?? 8000;
  const attempts = opts.attempts ?? 4;
  for (let i = 0; i < attempts; i++) {
    const r = await chatRaw({
      messages: opts.messages,
      temperature: opts.temperature,
      maxTokens,
      thinking: true,
      jsonMode: true,
    });
    const parsed = parseLooseJson<T>(r.content);
    if (parsed) return { parsed, usage: r.usage };
    // else: ran away / empty — try again.
  }
  return null;
}
