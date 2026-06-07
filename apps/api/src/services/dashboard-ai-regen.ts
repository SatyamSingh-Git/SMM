import { generateAiInsights } from "./dashboard-ai.js";
import { generateCommentThemes } from "./dashboard-comment-themes.js";
import {
  generateCaptionPatterns,
  captionPatternsKind,
} from "./dashboard-caption-patterns.js";
import { writeCached } from "./dashboard-cache.js";

/**
 * Regenerate every AI dashboard card from current DB data. Best-effort +
 * parallel — each section is independent, and a failure (no data, DeepSeek
 * hiccup) is captured rather than failing the whole call.
 *
 * Called from:
 *   - POST /dashboard/sync-insights (so one click refreshes the whole UI)
 *   - engagement-worker auto-backfill, after it ingests new posts
 *     (so the dashboard's "Focus this week" stays current even when the
 *     user never clicks Sync)
 *
 * generateCommentThemes/generateCaptionPatterns cache internally;
 * generateAiInsights returns a payload we cache here.
 */
export async function regenerateAllAiCaches(): Promise<
  Array<{ kind: string; ok: boolean; error?: string }>
> {
  const jobs: Array<[string, () => Promise<unknown>]> = [
    [
      "weeklyFocus:instagram",
      async () =>
        writeCached(
          "weeklyFocus:instagram",
          await generateAiInsights("instagram")
        ),
    ],
    [
      "weeklyFocus:threads",
      async () =>
        writeCached("weeklyFocus:threads", await generateAiInsights("threads")),
    ],
    ["commentThemes", () => generateCommentThemes()],
    [
      captionPatternsKind("instagram"),
      () => generateCaptionPatterns("instagram"),
    ],
    [captionPatternsKind("threads"), () => generateCaptionPatterns("threads")],
  ];
  return Promise.all(
    jobs.map(([kind, fn]) =>
      fn()
        .then(() => ({ kind, ok: true }))
        .catch((e) => ({ kind, ok: false, error: (e as Error).message }))
    )
  );
}
