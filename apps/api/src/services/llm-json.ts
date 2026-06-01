// Forgiving JSON extraction for LLM responses. Models occasionally wrap JSON in
// markdown fences, prepend prose, or — DeepSeek on heavy emoji/Devanagari input
// or when max_tokens truncates the output — return an empty or partial string.
// Returns null when nothing parseable is found (callers fall back gracefully
// instead of throwing a 500).

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function parseLooseJson<T>(raw: string | null | undefined): T | null {
  const txt = (raw ?? "").trim();
  if (!txt) return null;

  // 1. straight parse
  const direct = tryParse<T>(txt);
  if (direct !== null) return direct;

  // 2. strip ```json … ``` fences
  const stripped = txt
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const fenced = tryParse<T>(stripped);
  if (fenced !== null) return fenced;

  // 3. extract the first {...} block (handles leading prose)
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    const blob = tryParse<T>(match[0]);
    if (blob !== null) return blob;
  }

  return null;
}
