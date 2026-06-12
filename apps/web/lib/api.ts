import type {
  Account,
  Post,
  Platform,
  PostType,
  EngagementComment,
  DashboardKpis,
  TopPostRow,
  DashboardAiInsights,
  TypeBreakdownRow,
  FollowerTrendPoint,
  CommentThemes,
  SuperFan,
  CaptionPatterns,
  EngagementMix,
  MomentumPost,
} from "./types";

// ---------- Image-Prompt Writer types ----------
export type ImagePromptInput = {
  scene: string;
  personaDescriptor?: string;
  count?: number;
  outfit?: string;
  shotType?: string;
  cameraQuality?: string;
  photographer?: string;
  cameraAngles?: string[];
  locale?: string;
  lighting?: string;
  hairstyles?: string[];
  defaultPersonality?: boolean;
};
export type ImagePromptOptionCatalog = {
  outfit: Array<{ value: string; label: string }>;
  shotType: Array<{ value: string; label: string }>;
  cameraQuality: Array<{ value: string; label: string }>;
  photographer: Array<{ value: string; label: string }>;
  cameraAngle: Array<{ value: string; label: string }>;
  locale: Array<{ value: string; label: string }>;
  lighting: Array<{ value: string; label: string }>;
  hairstyle: Array<{ value: string; label: string }>;
};

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

function qsPlatform(p?: Platform): string {
  return p ? `?platform=${p}` : "";
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const { json, headers, ...rest } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : (rest as RequestInit).body,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail: unknown = text;
    try {
      detail = JSON.parse(text);
    } catch {}
    throw new Error(
      `${res.status} ${res.statusText}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
    );
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  health: () => request<{ ok: boolean; killSwitch: boolean }>("/health"),
  getSettings: () => request<import("./types").AppSettingsView>("/settings"),
  updateSettings: (patch: import("./types").AppSettingsPatch) =>
    request<import("./types").AppSettingsView>("/settings", {
      method: "PATCH",
      json: patch,
    }),
  listAccounts: () =>
    request<{ accounts: Account[] }>("/accounts").then((r) => r.accounts),
  refreshToken: (accountId: string) =>
    request<{ result: unknown; accounts: Account[] }>(
      `/accounts/${accountId}/refresh-token`,
      { method: "POST" }
    ),
  getPost: (id: string) => request<Post>(`/posts/${id}`),
  restorePost: (id: string) =>
    request<Post>(`/posts/${id}/restore`, { method: "POST" }),
  duplicatePost: (id: string) =>
    request<{ post: Post; targetPlatform: Platform }>(
      `/posts/${id}/duplicate`,
      { method: "POST" }
    ),
  rewriteHook: (input: { platform: Platform; caption: string }) =>
    request<{ hooks: string[] }>("/ai/rewrite-hook", {
      method: "POST",
      json: input,
    }).then((r) => r.hooks),
  suggestTopicTag: (caption: string) =>
    request<{ tags: string[] }>("/ai/suggest-topic-tag", {
      method: "POST",
      json: { caption },
    }).then((r) => r.tags),
  carouselCompanion: (prompts: string[]) =>
    request<{
      masterCaption: string;
      hashtags: string[];
      slides: Array<{ micro: string; alt: string }>;
    }>("/ai/image-prompts/carousel-text", {
      method: "POST",
      json: { prompts },
    }),
  dashboardShareHeavy: (platform?: Platform) =>
    request<{ posts: TopPostRow[] }>(
      `/dashboard/share-heavy${qsPlatform(platform)}`
    ).then((r) => r.posts),
  listPosts: (params?: {
    from?: string;
    to?: string;
    status?: string;
    platform?: Platform;
  }) => {
    const q = new URLSearchParams();
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    if (params?.status) q.set("status", params.status);
    if (params?.platform) q.set("platform", params.platform);
    const qs = q.toString();
    return request<{ posts: Post[] }>(`/posts${qs ? `?${qs}` : ""}`).then(
      (r) => r.posts
    );
  },
  createPost: (input: {
    accountId: string;
    platform: Platform;
    type: PostType;
    caption?: string;
    mediaAssetIds?: string[];
    assetMetas?: Array<{
      assetId: string;
      altText?: string;
      userTags?: Array<{ username: string; x: number; y: number }>;
    }>;
    replyChain?: Array<{ text?: string; assetIds?: string[] }>;
    igExtras?: {
      locationId?: string;
      locationName?: string;
      collaborators?: string[];
      thumbOffsetMs?: number;
      coverUrl?: string;
      isAiGenerated?: boolean;
    };
    topicTag?: string | null;
    scheduledAt?: string | null;
  }) => request<Post>("/posts", { method: "POST", json: input }),
  searchLocations: (accountId: string, q: string) =>
    request<{
      results: Array<{
        id: string;
        name: string;
        location?: { city?: string; country?: string; state?: string };
      }>;
    }>(
      `/locations/search?accountId=${encodeURIComponent(accountId)}&q=${encodeURIComponent(q)}`
    ),
  suggestCaptions: (input: {
    platform: Platform;
    postType: PostType;
    mode?: "fresh" | "enhance" | "from-image";
    existingCaption?: string;
    imageUrl?: string;
    voices?: Array<
      | "playful"
      | "cute"
      | "controversial"
      | "flirty"
      | "bold"
      | "mysterious"
      | "soft"
      | "edgy"
      | "viral-bait"
    >;
    languageMix?: "english" | "balanced" | "hindi-heavy";
    intent?: string;
    count?: number;
  }) =>
    request<{ suggestions: Array<{ caption: string; hashtags: string[] }> }>(
      "/ai/caption-suggest",
      { method: "POST", json: input }
    ),
  // ----- "What to Write": post ideas inspired by another post (text/image) -----
  inspire: (input: {
    platform: Platform;
    sourceText?: string;
    imageUrl?: string;
    voices?: Array<
      | "playful"
      | "cute"
      | "controversial"
      | "flirty"
      | "bold"
      | "mysterious"
      | "soft"
      | "edgy"
      | "viral-bait"
    >;
    languageMix?: "english" | "balanced" | "hindi-heavy";
    count?: number;
  }) =>
    request<{ suggestions: Array<{ caption: string; hashtags: string[] }> }>(
      "/ai/inspire",
      { method: "POST", json: input }
    ),
  // ----- Image-Prompt Writer: 3 image-gen prompts for one scene -----
  getImagePromptPersonaDefault: () =>
    request<{ defaultPersona: string }>("/ai/image-prompts/persona").then(
      (r) => r.defaultPersona
    ),
  getImagePromptOptions: () =>
    request<{ options: ImagePromptOptionCatalog }>(
      "/ai/image-prompts/options"
    ).then((r) => r.options),
  generateImagePrompts: (input: ImagePromptInput) =>
    request<{ prompts: string[] }>("/ai/image-prompts", {
      method: "POST",
      json: input,
    }).then((r) => r.prompts),
  updatePost: (
    id: string,
    patch: {
      type?: import("./types").PostType;
      caption?: string | null;
      mediaAssetIds?: string[];
      assetMetas?: Array<{
        assetId: string;
        altText?: string;
        userTags?: Array<{ username: string; x: number; y: number }>;
      }>;
      replyChain?: Array<{ text?: string; assetIds?: string[] }> | null;
      igExtras?: {
        locationId?: string;
        locationName?: string;
        collaborators?: string[];
        thumbOffsetMs?: number;
        coverUrl?: string;
        isAiGenerated?: boolean;
      } | null;
      topicTag?: string | null;
      scheduledAt?: string | null;
    }
  ) => request<Post>(`/posts/${id}`, { method: "PATCH", json: patch }),
  cancelPost: (id: string) =>
    request<Post>(`/posts/${id}`, { method: "DELETE" }),
  publishNow: (id: string) =>
    request<Post>(`/posts/${id}/publish-now`, { method: "POST" }),
  retryPost: (id: string) =>
    request<Post>(`/posts/${id}/retry`, { method: "POST" }),
  duplicateAsThreads: (id: string) =>
    request<{ post: Post; aiRewritten: boolean }>(
      `/posts/${id}/duplicate-as-threads`,
      { method: "POST" }
    ),
  // ----- Stage 2: engagement -----
  listEngagementComments: (params?: { status?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return request<{ comments: EngagementComment[] }>(
      `/engagement/comments${qs ? `?${qs}` : ""}`
    ).then((r) => r.comments);
  },
  engagementStats: () =>
    request<{
      counts: Record<string, number>;
      styleExamples: number;
      repliesToday: number;
      dailyCap: number;
      perPostCap: number;
    }>("/engagement/stats"),

  engagementSleepWindows: () =>
    request<{
      timezone: string;
      dateKey: string;
      todayIst: string;
      nowIst: string;
      fixedQuietWindows: Array<{
        start: string;
        end: string;
        durationMin: number;
        label: string;
      }>;
      dynamicSleepWindows: Array<{
        start: string;
        end: string;
        durationMin: number;
      }>;
      sessions: {
        morning: { start: string; end: string };
        evening: { start: string; end: string };
      };
    }>("/engagement/sleep-windows"),
  learnStyle: () =>
    request<{
      scannedPosts: number;
      pairsFound: number;
      inserted: number;
      duplicates: number;
    }>("/engagement/learn-style", { method: "POST" }),
  pollEngagementNow: () =>
    request<{ scanned: number; queued: number; skipped: number }>(
      "/engagement/poll-now",
      { method: "POST" }
    ),
  cancelEngagement: (id: string) =>
    request<EngagementComment>(`/engagement/comments/${id}/cancel`, {
      method: "POST",
    }),
  retryEngagement: (id: string) =>
    request<{ ok: boolean }>(`/engagement/comments/${id}/retry`, {
      method: "POST",
    }),
  previewEngagementReply: (id: string) =>
    request<{
      shouldReply: boolean;
      reply: string | null;
      reason: string | null;
    }>(`/engagement/comments/${id}/preview`, { method: "POST" }),

  // ----- Dashboard -----
  // Every endpoint accepts an optional `platform` filter. Omit it to get
  // aggregated numbers across IG + Threads.
  dashboardKpis: (platform?: Platform) =>
    request<DashboardKpis>(`/dashboard/kpis${qsPlatform(platform)}`),
  dashboardTopPosts: (days = 30, platform?: Platform) =>
    request<{ posts: TopPostRow[] }>(
      `/dashboard/top-posts?days=${days}${platform ? `&platform=${platform}` : ""}`
    ).then((r) => r.posts),
  dashboardHeatmap: (platform?: Platform) =>
    request<{ heatmap: number[][] }>(
      `/dashboard/heatmap${qsPlatform(platform)}`
    ).then((r) => r.heatmap),
  dashboardBestTimes: (platform?: Platform) =>
    request<import("./types").BestTimes>(
      `/dashboard/best-times${qsPlatform(platform)}`
    ),
  dashboardTypeBreakdown: (platform?: Platform) =>
    request<{ rows: TypeBreakdownRow[] }>(
      `/dashboard/type-breakdown${qsPlatform(platform)}`
    ).then((r) => r.rows),
  dashboardFollowerTrend: (platform?: Platform) =>
    request<{ points: FollowerTrendPoint[] }>(
      `/dashboard/follower-trend${qsPlatform(platform)}`
    ).then((r) => r.points),
  dashboardAiInsights: (platform?: Platform, refresh = false) => {
    const q = new URLSearchParams();
    if (platform) q.set("platform", platform);
    if (refresh) q.set("refresh", "1");
    const qs = q.toString();
    return request<DashboardAiInsights>(
      `/dashboard/ai-insights${qs ? `?${qs}` : ""}`
    );
  },
  // Tier 1 — per-section, manual-refresh-only
  dashboardCommentThemes: (refresh = false) =>
    request<CommentThemes>(
      `/dashboard/comment-themes${refresh ? "?refresh=1" : ""}`
    ),
  dashboardSuperFans: () =>
    request<{ fans: SuperFan[] }>("/dashboard/super-fans").then((r) => r.fans),
  dashboardCaptionPatterns: (platform?: Platform, refresh = false) => {
    const q = new URLSearchParams();
    if (platform) q.set("platform", platform);
    if (refresh) q.set("refresh", "1");
    const qs = q.toString();
    return request<CaptionPatterns>(
      `/dashboard/caption-patterns${qs ? `?${qs}` : ""}`
    );
  },
  dashboardEngagementMix: (platform?: Platform) => {
    const q = platform ? `?platform=${platform}` : "";
    return request<EngagementMix>(`/dashboard/engagement-mix${q}`);
  },
  dashboardMomentum: () =>
    request<{ posts: MomentumPost[] }>("/dashboard/momentum").then(
      (r) => r.posts
    ),

  dashboardSyncNow: (opts?: { backfill?: boolean }) =>
    request<{
      backfill: {
        threadsScanned: number;
        threadsCreated: number;
        instagramScanned: number;
        instagramCreated: number;
      } | null;
      post: { scanned: number; captured: number; errors: number };
      account: { captured: number; errors: number };
      comments?: { scanned: number; queued: number; skipped: number } | null;
      ai?: Array<{ kind: string; ok: boolean; error?: string }>;
    }>(
      `/dashboard/sync-insights${opts?.backfill ? "?backfill=1" : ""}`,
      { method: "POST" }
    ),

  uploadMedia: async (file: File, accountId: string) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(
      `${API_BASE}/media?accountId=${encodeURIComponent(accountId)}`,
      { method: "POST", body: fd }
    );
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return res.json() as Promise<{
      id: string;
      publicUrl: string;
      mimeType: string;
    }>;
  },
};
