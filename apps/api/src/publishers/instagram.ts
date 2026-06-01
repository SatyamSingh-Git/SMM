// Instagram Graph API publisher (Instagram Login flow — `graph.instagram.com`).
// Two-step publish like Threads: create container → publish.
// Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing

const IG_API = "https://graph.instagram.com/v22.0";

export class InstagramApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
    this.name = "InstagramApiError";
  }
}

async function call<T>(
  path: string,
  method: "GET" | "POST",
  params: Record<string, string>
): Promise<T> {
  const url = new URL(`${IG_API}${path}`);
  const body =
    method === "GET" ? undefined : new URLSearchParams(params).toString();
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method,
    body,
    headers:
      method === "POST"
        ? { "content-type": "application/x-www-form-urlencoded" }
        : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new InstagramApiError(
      res.status,
      json,
      `Instagram API ${method} ${path} failed: ${res.status} ${text}`
    );
  }
  return json as T;
}

export async function getMe(accessToken: string): Promise<{
  id: string;
  username: string;
}> {
  return call<{ id: string; username: string }>("/me", "GET", {
    fields: "id,username",
    access_token: accessToken,
  });
}

export type IgUserTag = { username: string; x: number; y: number };

export type IgCommonExtras = {
  locationId?: string;
  collaborators?: string[]; // IG usernames
};

export type InstagramImagePost = {
  imageUrl: string;
  caption?: string;
  altText?: string;
  userTags?: IgUserTag[];
  extras?: IgCommonExtras;
};

type ContainerStatus =
  | "EXPIRED"
  | "ERROR"
  | "FINISHED"
  | "IN_PROGRESS"
  | "PUBLISHED";

/**
 * Poll a media container until it finishes processing (or errors out).
 * Images usually finish in 1-3s; videos can take a minute or more.
 */
async function waitForContainer(
  containerId: string,
  accessToken: string,
  opts: { maxWaitMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const { status_code } = await call<{ status_code: ContainerStatus }>(
      `/${containerId}`,
      "GET",
      { fields: "status_code", access_token: accessToken }
    );
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new InstagramApiError(
        500,
        { status_code },
        `Container ${containerId} ended in ${status_code}`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new InstagramApiError(
    504,
    { containerId },
    `Container ${containerId} did not finish within ${maxWaitMs}ms`
  );
}

/**
 * Apply IG container extras (location/collaborators/userTags/altText) onto a
 * media-create params object. Centralised so every adapter handles them
 * consistently.
 */
function applyExtras(
  params: Record<string, string>,
  opts: {
    altText?: string;
    userTags?: IgUserTag[];
    extras?: IgCommonExtras;
  }
): void {
  if (opts.altText) params.alt_text = opts.altText;
  if (opts.userTags && opts.userTags.length > 0) {
    // Meta accepts a JSON-stringified array of {username, x, y}.
    params.user_tags = JSON.stringify(opts.userTags);
  }
  if (opts.extras?.locationId) params.location_id = opts.extras.locationId;
  if (opts.extras?.collaborators && opts.extras.collaborators.length > 0) {
    // Strip leading @ and dedupe.
    const cleaned = Array.from(
      new Set(opts.extras.collaborators.map((u) => u.replace(/^@/, "")))
    );
    params.collaborators = JSON.stringify(cleaned);
  }
}

/**
 * Publish a single-image feed post.
 * imageUrl MUST be a publicly-reachable HTTPS URL (JPEG).
 */
export async function publishImage(
  userId: string,
  accessToken: string,
  post: InstagramImagePost
): Promise<{ id: string }> {
  const params: Record<string, string> = {
    image_url: post.imageUrl,
    access_token: accessToken,
  };
  if (post.caption) params.caption = post.caption;
  applyExtras(params, post);

  const container = await call<{ id: string }>(
    `/${userId}/media`,
    "POST",
    params
  );

  await waitForContainer(container.id, accessToken);

  const published = await call<{ id: string }>(
    `/${userId}/media_publish`,
    "POST",
    {
      creation_id: container.id,
      access_token: accessToken,
    }
  );

  return { id: published.id };
}

/**
 * Publish a Reel.
 * videoUrl MUST be a publicly-reachable HTTPS MP4 (H.264 + AAC, ≤90s recommended).
 * Reels processing takes longer than images — allow up to 5 minutes.
 */
export async function publishReel(
  userId: string,
  accessToken: string,
  post: {
    videoUrl: string;
    caption?: string;
    shareToFeed?: boolean;
    thumbOffsetMs?: number; // pick the cover frame at this millisecond
    coverUrl?: string; // custom cover JPEG; takes precedence over thumbOffsetMs
    altText?: string;
    userTags?: IgUserTag[];
    extras?: IgCommonExtras;
  }
): Promise<{ id: string }> {
  const params: Record<string, string> = {
    media_type: "REELS",
    video_url: post.videoUrl,
    share_to_feed: post.shareToFeed === false ? "false" : "true",
    access_token: accessToken,
  };
  if (post.caption) params.caption = post.caption;
  if (post.thumbOffsetMs !== undefined) {
    params.thumb_offset = String(post.thumbOffsetMs);
  }
  if (post.coverUrl) params.cover_url = post.coverUrl;
  applyExtras(params, post);

  const container = await call<{ id: string }>(
    `/${userId}/media`,
    "POST",
    params
  );

  await waitForContainer(container.id, accessToken, { maxWaitMs: 5 * 60_000 });

  const published = await call<{ id: string }>(
    `/${userId}/media_publish`,
    "POST",
    { creation_id: container.id, access_token: accessToken }
  );
  return { id: published.id };
}

/**
 * Publish a Story (image or video).
 * Stories do not accept a caption; tags/stickers are out of scope for Stage 1.
 */
export async function publishStory(
  userId: string,
  accessToken: string,
  post: { mediaUrl: string; mediaType: "image" | "video" }
): Promise<{ id: string }> {
  const params: Record<string, string> = {
    media_type: "STORIES",
    access_token: accessToken,
  };
  if (post.mediaType === "image") {
    params.image_url = post.mediaUrl;
  } else {
    params.video_url = post.mediaUrl;
  }

  const container = await call<{ id: string }>(
    `/${userId}/media`,
    "POST",
    params
  );

  await waitForContainer(container.id, accessToken, {
    maxWaitMs: post.mediaType === "video" ? 5 * 60_000 : 60_000,
  });

  const published = await call<{ id: string }>(
    `/${userId}/media_publish`,
    "POST",
    { creation_id: container.id, access_token: accessToken }
  );
  return { id: published.id };
}

/**
 * Publish a Carousel (2-10 image/video items).
 * Each child can carry its own altText + userTags; location/collaborators
 * apply to the carousel container itself.
 */
export async function publishCarousel(
  userId: string,
  accessToken: string,
  post: {
    items: Array<{
      url: string;
      type: "image" | "video";
      altText?: string;
      userTags?: IgUserTag[];
    }>;
    caption?: string;
    extras?: IgCommonExtras;
  }
): Promise<{ id: string }> {
  if (post.items.length < 2 || post.items.length > 10) {
    throw new InstagramApiError(
      400,
      { count: post.items.length },
      `Carousel must have 2-10 items (got ${post.items.length})`
    );
  }

  const childIds: string[] = [];
  for (const item of post.items) {
    const params: Record<string, string> = {
      is_carousel_item: "true",
      access_token: accessToken,
    };
    if (item.type === "image") {
      params.image_url = item.url;
    } else {
      params.media_type = "VIDEO";
      params.video_url = item.url;
    }
    // Per-child extras: alt_text and user_tags only. Location/collaborators
    // are not valid on children — they belong on the parent CAROUSEL container.
    applyExtras(params, {
      altText: item.altText,
      userTags: item.userTags,
    });
    const child = await call<{ id: string }>(
      `/${userId}/media`,
      "POST",
      params
    );
    if (item.type === "video") {
      await waitForContainer(child.id, accessToken, { maxWaitMs: 5 * 60_000 });
    }
    childIds.push(child.id);
  }

  const carouselParams: Record<string, string> = {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    access_token: accessToken,
  };
  if (post.caption) carouselParams.caption = post.caption;
  // Apply container-level extras (location + collaborators).
  applyExtras(carouselParams, { extras: post.extras });

  const carousel = await call<{ id: string }>(
    `/${userId}/media`,
    "POST",
    carouselParams
  );

  await waitForContainer(carousel.id, accessToken);

  const published = await call<{ id: string }>(
    `/${userId}/media_publish`,
    "POST",
    { creation_id: carousel.id, access_token: accessToken }
  );
  return { id: published.id };
}

export function instagramPostUrl(permalink?: string, _postId?: string): string | undefined {
  return permalink;
}

// ---------- Insights ----------

export type InstagramPostInsights = {
  reach?: number;
  impressions?: number;
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  profileVisits?: number;
  follows?: number;
  views?: number;
  raw: unknown;
};

// IG's insights endpoint is per media id. We ask for the union of metrics
// across all post types; Meta returns only what's applicable. Unknown metrics
// for a given media type return an error string in the values; we silently
// drop those.
const IG_POST_METRICS = [
  "reach",
  "impressions",
  "likes",
  "comments",
  "saves",
  "shares",
  "profile_visits",
  "follows",
  "views",
] as const;

export async function fetchPostInsights(
  mediaId: string,
  accessToken: string
): Promise<InstagramPostInsights> {
  const out: InstagramPostInsights = { raw: null };
  // We request each metric individually and tolerate per-metric failures so
  // one unsupported metric doesn't blow up the whole request.
  const results: Record<string, unknown> = {};
  for (const m of IG_POST_METRICS) {
    try {
      const r = await call<{
        data?: Array<{ name: string; values?: Array<{ value: number }> }>;
      }>(`/${mediaId}/insights`, "GET", {
        metric: m,
        access_token: accessToken,
      });
      const v = r.data?.[0]?.values?.[0]?.value;
      if (typeof v === "number") results[m] = v;
    } catch {
      // metric not available for this post type — skip silently
    }
  }
  out.raw = results;
  if (typeof results.reach === "number") out.reach = results.reach as number;
  if (typeof results.impressions === "number") out.impressions = results.impressions as number;
  if (typeof results.likes === "number") out.likes = results.likes as number;
  if (typeof results.comments === "number") out.comments = results.comments as number;
  if (typeof results.saves === "number") out.saves = results.saves as number;
  if (typeof results.shares === "number") out.shares = results.shares as number;
  if (typeof results.profile_visits === "number") out.profileVisits = results.profile_visits as number;
  if (typeof results.follows === "number") out.follows = results.follows as number;
  if (typeof results.views === "number") out.views = results.views as number;
  return out;
}

// ---------- Listing past media (for backfill) ----------

export type InstagramMediaSummary = {
  id: string;
  caption: string | null;
  mediaType: string; // IMAGE | VIDEO | CAROUSEL_ALBUM
  mediaProductType: string | null; // FEED | REELS | STORY
  permalink: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  timestamp: string; // ISO
};

/**
 * Pull the user's recent media. Paginates until we either run out of posts
 * or hit `sinceMs` (no point fetching older than the dashboard's window).
 */
export async function listMyMedia(
  userId: string,
  accessToken: string,
  opts: { sinceMs?: number; maxPages?: number } = {}
): Promise<InstagramMediaSummary[]> {
  const maxPages = opts.maxPages ?? 8;
  const out: InstagramMediaSummary[] = [];
  let after: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const params: Record<string, string> = {
      fields:
        "id,caption,media_type,media_product_type,permalink,media_url,thumbnail_url,timestamp",
      limit: "25",
      access_token: accessToken,
    };
    if (after) params.after = after;
    const r = await call<{
      data?: Array<{
        id: string;
        caption?: string;
        media_type?: string;
        media_product_type?: string;
        permalink?: string;
        media_url?: string;
        thumbnail_url?: string;
        timestamp?: string;
      }>;
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`/${userId}/media`, "GET", params);
    const page = r.data ?? [];
    let hitOld = false;
    for (const item of page) {
      if (!item.id || !item.timestamp) continue;
      const ts = Date.parse(item.timestamp);
      if (opts.sinceMs && ts < opts.sinceMs) {
        hitOld = true;
        continue;
      }
      out.push({
        id: item.id,
        caption: item.caption ?? null,
        mediaType: item.media_type ?? "IMAGE",
        mediaProductType: item.media_product_type ?? null,
        permalink: item.permalink ?? null,
        mediaUrl: item.media_url ?? null,
        thumbnailUrl: item.thumbnail_url ?? null,
        timestamp: item.timestamp,
      });
    }
    if (hitOld || !r.paging?.next || !r.paging.cursors?.after) break;
    after = r.paging.cursors.after;
  }
  return out;
}

export type InstagramAccountSnapshot = {
  followers: number;
  following?: number;
  postsCount?: number;
};

export async function fetchAccountSnapshot(
  userId: string,
  accessToken: string
): Promise<InstagramAccountSnapshot> {
  const r = await call<{
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
  }>(`/${userId}`, "GET", {
    fields: "followers_count,follows_count,media_count",
    access_token: accessToken,
  });
  return {
    followers: r.followers_count ?? 0,
    following: r.follows_count,
    postsCount: r.media_count,
  };
}
