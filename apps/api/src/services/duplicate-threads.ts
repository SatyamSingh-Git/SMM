// "Duplicate as Threads draft" — turn any existing post (usually an IG post)
// into a SEPARATE, native Threads draft.
//
// This is NOT cross-posting. Cross-posting an IG caption to Threads silently
// truncates at 500 chars and strips hashtags. Threads rewards its own native
// voice (conversational, hook-first, no hashtags). So we reuse the existing
// caption writer in `threads` mode to REINTERPRET the source caption as a
// brand-new Threads post, then save it as a draft the user edits + schedules
// independently. Zero schema change: it just creates a normal threads_post draft.

import { prisma } from "@smm/db";
import { getPost, createPost } from "./posts.js";
import { suggestCaptions } from "./ai.js";

export type DuplicateResult = {
  post: Awaited<ReturnType<typeof createPost>>;
  // True when DeepSeek rewrote the caption; false when we fell back to a plain
  // truncated copy (no source caption, or the model call failed).
  aiRewritten: boolean;
};

export async function duplicateAsThreadsDraft(
  sourceId: string
): Promise<DuplicateResult | null> {
  const source = await getPost(sourceId);
  if (!source) return null;

  // Need a Threads account to own the new draft.
  const threadsAccount = await prisma.account.findFirst({
    where: { platform: "threads" },
  });
  if (!threadsAccount) {
    throw new Error("no Threads account connected");
  }

  const srcCaption = source.caption?.trim() ?? "";

  let caption = srcCaption.slice(0, 500);
  let aiRewritten = false;

  if (srcCaption.length > 0) {
    try {
      // Reinterpret the source caption as a native Threads post. `enhance` mode
      // keeps the core intent but rewrites to the Threads voice (hook-first,
      // ≤500 chars, no hashtags). cacheLabel keeps prompt-cache telemetry honest.
      const suggestions = await suggestCaptions({
        platform: "threads",
        postType: "threads_post",
        mode: "enhance",
        existingCaption: srcCaption,
        languageMix: "english",
        count: 1,
      });
      const first = suggestions[0]?.caption?.trim();
      if (first) {
        caption = first.slice(0, 500);
        aiRewritten = true;
      }
    } catch (e) {
      // Non-fatal: fall back to the plain truncated copy. The user can hit
      // "regenerate" in the composer if they want the AI rewrite.
      console.warn(
        "[duplicate-threads] caption rewrite failed, using plain copy:",
        (e as Error).message
      );
    }
  }

  const post = await createPost({
    accountId: threadsAccount.id,
    platform: "threads",
    type: "threads_post",
    caption: caption || undefined,
    mediaAssetIds: [],
    scheduledAt: null, // draft — user edits + schedules independently
  });

  return { post, aiRewritten };
}
