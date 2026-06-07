import type { FastifyInstance } from "fastify";
import type { Platform } from "@smm/db";
import {
  getKpis,
  getRecentPostsWithLatestInsight,
  getPostingHeatmap,
  getTypeBreakdown,
  getFollowerTrend,
} from "../services/dashboard-analytics.js";
import { generateAiInsights } from "../services/dashboard-ai.js";
import { syncPostInsights, syncAccountSnapshots } from "../services/insights-sync.js";
import { backfillFromPlatforms } from "../services/backfill.js";
import { pollForNewComments } from "../services/engagement.js";
import {
  generateCommentThemes,
  type CommentThemesPayload,
} from "../services/dashboard-comment-themes.js";
import { getSuperFans } from "../services/dashboard-super-fans.js";
import {
  generateCaptionPatterns,
  captionPatternsKind,
  type CaptionPatternsPayload,
} from "../services/dashboard-caption-patterns.js";
import { getEngagementMix } from "../services/dashboard-engagement-mix.js";
import { getMomentumPosts } from "../services/dashboard-momentum.js";
import { getCachedOrNull, writeCached } from "../services/dashboard-cache.js";
import { regenerateAllAiCaches } from "../services/dashboard-ai-regen.js";

// All AI sections cache to DB. Refresh only fires when the user clicks
// the section's ↻ button (?refresh=1). Otherwise we return the cached
// payload or null (UI shows a "click to generate" empty state).

function readPlatform(req: { query: unknown }): Platform | undefined {
  const p = (req.query as { platform?: string }).platform;
  if (p === "instagram" || p === "threads") return p;
  return undefined;
}
function readRefresh(req: { query: unknown }): boolean {
  return (req.query as { refresh?: string }).refresh === "1";
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/dashboard/kpis", async (req) => getKpis({ platform: readPlatform(req) }));

  app.get("/dashboard/top-posts", async (req) => {
    const days = Math.max(7, Math.min(90, Number((req.query as { days?: string }).days) || 30));
    const posts = await getRecentPostsWithLatestInsight({
      days,
      limit: 24,
      platform: readPlatform(req),
    });
    return {
      posts: posts.sort((a, b) => b.engagement - a.engagement).slice(0, 12),
    };
  });

  app.get("/dashboard/heatmap", async (req) => {
    return { heatmap: await getPostingHeatmap(60, readPlatform(req)) };
  });

  app.get("/dashboard/type-breakdown", async (req) => {
    return { rows: await getTypeBreakdown(30, readPlatform(req)) };
  });

  app.get("/dashboard/follower-trend", async (req) => {
    return { points: await getFollowerTrend(60, readPlatform(req)) };
  });

  // ---------- AI sections (manual refresh only, DB-cached) ----------

  // Weekly focus / wins / warnings / try-next, per platform. Cache key is
  // "weeklyFocus:instagram" | "weeklyFocus:threads" (or "weeklyFocus" if no
  // platform is passed). Each platform gets its own, single-platform analysis.
  app.get("/dashboard/ai-insights", async (req) => {
    const platform = readPlatform(req);
    const kind = platform ? `weeklyFocus:${platform}` : "weeklyFocus";
    const refresh = readRefresh(req);
    if (!refresh) {
      const cached = await getCachedOrNull<unknown>(kind);
      if (cached) return { ...(cached.payload as object), generatedAt: cached.generatedAt };
      // Cold start: no cached payload yet — generate once on first read.
    }
    const out = await generateAiInsights(platform);
    await writeCached(kind, out);
    return out;
  });

  // Comment themes (sentiment buckets + topic clusters).
  app.get("/dashboard/comment-themes", async (req) => {
    const refresh = readRefresh(req);
    if (!refresh) {
      const cached = await getCachedOrNull<CommentThemesPayload>("commentThemes");
      if (cached) {
        return { ...cached.payload, generatedAt: cached.generatedAt, cached: true };
      }
      return { generatedAt: null, cached: false, empty: true };
    }
    const payload = await generateCommentThemes();
    return { ...payload, generatedAt: new Date().toISOString(), cached: false };
  });

  // Caption patterns (AI extracts what makes the top posts top), per platform.
  app.get("/dashboard/caption-patterns", async (req) => {
    const platform = readPlatform(req);
    const kind = captionPatternsKind(platform);
    const refresh = readRefresh(req);
    if (!refresh) {
      const cached = await getCachedOrNull<CaptionPatternsPayload>(kind);
      if (cached) {
        return { ...cached.payload, generatedAt: cached.generatedAt, cached: true };
      }
      return { generatedAt: null, cached: false, empty: true };
    }
    const payload = await generateCaptionPatterns(platform);
    return { ...payload, generatedAt: new Date().toISOString(), cached: false };
  });

  // ---------- SQL-only sections (always fresh, no caching needed) ----------

  app.get("/dashboard/super-fans", async (req) => {
    const days = Math.max(7, Math.min(90, Number((req.query as { days?: string }).days) || 30));
    return { fans: await getSuperFans({ days }) };
  });

  app.get("/dashboard/engagement-mix", async (req) => {
    return getEngagementMix({ platform: readPlatform(req), days: 30 });
  });

  app.get("/dashboard/momentum", async () => {
    return { posts: await getMomentumPosts() };
  });

  // ---------- Sync (manual) ----------

  app.post("/dashboard/sync-insights", async (req) => {
    const forceBackfill = (req.query as { backfill?: string }).backfill === "1";
    // ALWAYS backfill — the user clicks Sync expecting fresh data, and we
    // can't see posts they made directly in the Threads/Instagram apps
    // without it. Force flag widens the window from 14 to 60 days.
    const daysBack = forceBackfill ? 60 : 14;
    // Wrap in try/catch so a Meta hiccup doesn't 500 the whole Sync button —
    // the insights / snapshot / comment / AI steps can still succeed even if
    // backfill errored. The error is surfaced in the response.
    let backfill: Awaited<ReturnType<typeof backfillFromPlatforms>> | null = null;
    let backfillError: string | null = null;
    try {
      backfill = await backfillFromPlatforms({ daysBack });
    } catch (e) {
      backfillError = (e as Error).message;
      app.log.error({ err: e }, "sync-insights: backfill failed");
    }
    // Keep postLimit at 50 even after backfill — bumping to 200 triples Meta
    // calls in a single burst and was hitting Meta's user-level read budget.
    // The periodic insights sync will catch up on the rest within hours.
    const post = await syncPostInsights({ postLimit: 50 });
    const acct = await syncAccountSnapshots();
    // Poll Threads for new comments so the audience cards (super-fans + comment
    // themes) reflect the latest — this is the one "refresh everything" button.
    // Best-effort: pollForNewComments swallows its own Threads API errors.
    let comments: Awaited<ReturnType<typeof pollForNewComments>> | null = null;
    try {
      comments = await pollForNewComments();
    } catch (e) {
      app.log.error({ err: e }, "sync-insights: comment poll failed");
    }
    // With fresh data in the DB, regenerate every AI card so the whole
    // dashboard updates on this one click (per-platform AI insights + caption
    // patterns + comment themes).
    const ai = await regenerateAllAiCaches();
    return { backfill, backfillError, post, account: acct, comments, ai };
  });

  app.post("/dashboard/backfill", async (req) => {
    const daysBack = Math.max(
      7,
      Math.min(365, Number((req.query as { days?: string }).days) || 60)
    );
    const r = await backfillFromPlatforms({ daysBack });
    return r;
  });
}
