// Threads API v1.0 publisher.
// Supports text, image, video, and carousel — plus self-reply chains where
// each item can carry its own media.
//
// Pattern (same as IG): create container -> poll status until FINISHED ->
// publish container. Carousel adds a "children" step first.
//
// Docs: https://developers.facebook.com/docs/threads/posts

import { consumeOrThrottle } from "../services/rate-limiter.js";

const THREADS_API = "https://graph.threads.net/v1.0";

export class ThreadsApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
    this.name = "ThreadsApiError";
  }
}

async function call<T>(
  path: string,
  method: "GET" | "POST",
  params: Record<string, string>
): Promise<T> {
  // Guard every read against the per-hour budget. Writes (POSTs) go through
  // the daily publish-side limiters elsewhere; this catches the high-volume
  // read traffic (comment poller, backfill, insights).
  if (method === "GET") {
    await consumeOrThrottle("threads_read", "threads");
  }
  const url = new URL(`${THREADS_API}${path}`);
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
    throw new ThreadsApiError(
      res.status,
      json,
      `Threads API ${method} ${path} failed: ${res.status} ${text}`
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

// Threads container status. Same shape as IG.
type ContainerStatus =
  | "EXPIRED"
  | "ERROR"
  | "FINISHED"
  | "IN_PROGRESS"
  | "PUBLISHED";

async function waitForContainer(
  containerId: string,
  accessToken: string,
  opts: { maxWaitMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { status } = await call<{ status: ContainerStatus; error_message?: string }>(
      `/${containerId}`,
      "GET",
      { fields: "status,error_message", access_token: accessToken }
    );
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new ThreadsApiError(
        500,
        { status },
        `Threads container ${containerId} ended in ${status}`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new ThreadsApiError(
    504,
    { containerId },
    `Threads container ${containerId} did not finish within ${maxWaitMs}ms`
  );
}

// One Threads post or one item in a self-reply chain. Carousel children
// are specified via `carouselItems` (2-20 items). For a single text/image/
// video post, leave `carouselItems` empty and pass `imageUrl` or `videoUrl`
// (or neither for text-only).
export type ThreadsItemSpec = {
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  altText?: string;
  carouselItems?: Array<{
    imageUrl?: string;
    videoUrl?: string;
    altText?: string;
  }>;
  replyToId?: string;
};

function pickMediaType(spec: ThreadsItemSpec): "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL" {
  if (spec.carouselItems && spec.carouselItems.length > 0) return "CAROUSEL";
  if (spec.videoUrl) return "VIDEO";
  if (spec.imageUrl) return "IMAGE";
  return "TEXT";
}

/**
 * Publish a single Threads item (text, image, video, or carousel).
 * Returns the platform post id of the published thread.
 */
export async function publishItem(
  userId: string,
  accessToken: string,
  spec: ThreadsItemSpec
): Promise<{ id: string }> {
  const mediaType = pickMediaType(spec);

  // ---- CAROUSEL: create children first, then parent ----
  if (mediaType === "CAROUSEL") {
    const items = spec.carouselItems ?? [];
    if (items.length < 2 || items.length > 20) {
      throw new ThreadsApiError(
        400,
        {},
        `Threads carousel requires 2-20 items; got ${items.length}`
      );
    }
    const childIds: string[] = [];
    for (const item of items) {
      const childParams: Record<string, string> = {
        is_carousel_item: "true",
        access_token: accessToken,
      };
      if (item.videoUrl) {
        childParams.media_type = "VIDEO";
        childParams.video_url = item.videoUrl;
      } else if (item.imageUrl) {
        childParams.media_type = "IMAGE";
        childParams.image_url = item.imageUrl;
      } else {
        throw new ThreadsApiError(400, {}, "Carousel item missing media url");
      }
      if (item.altText) childParams.alt_text = item.altText;
      const child = await call<{ id: string }>(
        `/${userId}/threads`,
        "POST",
        childParams
      );
      // Wait for each child to finish processing before referencing it.
      await waitForContainer(child.id, accessToken);
      childIds.push(child.id);
    }

    const parentParams: Record<string, string> = {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      access_token: accessToken,
    };
    if (spec.text) parentParams.text = spec.text;
    if (spec.replyToId) parentParams.reply_to_id = spec.replyToId;

    const parent = await call<{ id: string }>(
      `/${userId}/threads`,
      "POST",
      parentParams
    );
    await waitForContainer(parent.id, accessToken);
    const published = await call<{ id: string }>(
      `/${userId}/threads_publish`,
      "POST",
      { creation_id: parent.id, access_token: accessToken }
    );
    return { id: published.id };
  }

  // ---- SINGLE: text, image, or video ----
  const params: Record<string, string> = {
    media_type: mediaType,
    access_token: accessToken,
  };
  if (spec.text) params.text = spec.text;
  if (spec.imageUrl) params.image_url = spec.imageUrl;
  if (spec.videoUrl) params.video_url = spec.videoUrl;
  if (spec.altText) params.alt_text = spec.altText;
  if (spec.replyToId) params.reply_to_id = spec.replyToId;

  // Threads requires at least text or media.
  if (mediaType === "TEXT" && !spec.text) {
    throw new ThreadsApiError(400, {}, "Threads post requires text or media");
  }

  const container = await call<{ id: string }>(
    `/${userId}/threads`,
    "POST",
    params
  );

  // Video and image both need a short processing wait. Text is instant
  // but polling is a no-op for FINISHED-on-create, so we always poll.
  await waitForContainer(container.id, accessToken);

  const published = await call<{ id: string }>(
    `/${userId}/threads_publish`,
    "POST",
    { creation_id: container.id, access_token: accessToken }
  );
  return { id: published.id };
}

/**
 * Backwards-compatible text-only publish (used by /test/threads).
 */
export async function publishText(
  userId: string,
  accessToken: string,
  post: { text: string; replyToId?: string }
): Promise<{ id: string }> {
  return publishItem(userId, accessToken, {
    text: post.text,
    replyToId: post.replyToId,
  });
}

export function threadsPostUrl(username: string, postId: string): string {
  return `https://www.threads.net/@${username}/post/${postId}`;
}

// ---------- Insights ----------

export type ThreadsPostInsights = {
  views?: number;
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  shares?: number;
  raw: unknown;
};

const THREADS_POST_METRICS = [
  "views",
  "likes",
  "replies",
  "reposts",
  "quotes",
  "shares",
] as const;

export async function fetchPostInsights(
  threadId: string,
  accessToken: string
): Promise<ThreadsPostInsights> {
  const r = await call<{
    data?: Array<{
      name: string;
      values?: Array<{ value: number }>;
      total_value?: { value: number };
    }>;
  }>(`/${threadId}/insights`, "GET", {
    metric: THREADS_POST_METRICS.join(","),
    access_token: accessToken,
  });
  const out: ThreadsPostInsights = { raw: r.data ?? null };
  for (const item of r.data ?? []) {
    const v = item.total_value?.value ?? item.values?.[0]?.value;
    if (typeof v !== "number") continue;
    switch (item.name) {
      case "views": out.views = v; break;
      case "likes": out.likes = v; break;
      case "replies": out.replies = v; break;
      case "reposts": out.reposts = v; break;
      case "quotes": out.quotes = v; break;
      case "shares": out.shares = v; break;
    }
  }
  return out;
}

export type ThreadsAccountSnapshot = {
  followers: number;
};

export async function fetchAccountSnapshot(
  userId: string,
  accessToken: string
): Promise<ThreadsAccountSnapshot> {
  // Threads exposes followers_count via /me/threads_insights — single bucket.
  try {
    const r = await call<{
      data?: Array<{ name: string; total_value?: { value: number }; values?: Array<{ value: number }> }>;
    }>(`/${userId}/threads_insights`, "GET", {
      metric: "followers_count",
      access_token: accessToken,
    });
    const f = r.data?.[0];
    const v = f?.total_value?.value ?? f?.values?.[0]?.value ?? 0;
    return { followers: typeof v === "number" ? v : 0 };
  } catch {
    return { followers: 0 };
  }
}

// ---------- Read endpoints used by Stage 2 (engagement) ----------

export type ThreadsPost = {
  id: string;
  text?: string;
  timestamp?: string;
  permalink?: string;
};

/**
 * List the authenticated user's recent Threads posts.
 * Newest first.
 */
export async function listMyPosts(
  userId: string,
  accessToken: string,
  opts: { limit?: number; since?: Date } = {}
): Promise<ThreadsPost[]> {
  const params: Record<string, string> = {
    fields: "id,text,timestamp,permalink",
    limit: String(opts.limit ?? 25),
    access_token: accessToken,
  };
  if (opts.since) {
    // Meta accepts ISO timestamp or unix seconds. Use unix for stability.
    params.since = String(Math.floor(opts.since.getTime() / 1000));
  }
  const out = await call<{ data?: ThreadsPost[] }>(
    `/${userId}/threads`,
    "GET",
    params
  );
  return out.data ?? [];
}

export type ThreadsConversationNode = {
  id: string;
  text?: string;
  // Per Meta's docs, the comment author is exposed as a top-level `username`
  // field on each node — there is no `from` object on conversation/reply
  // responses. We keep `from` as an optional fallback for legacy callers.
  username?: string;
  timestamp?: string;
  // The parent thread this is a reply to (root post or another comment).
  replied_to?: { id: string };
  // Legacy / defensive: some older clients used `from.id`/`from.username`,
  // but Meta's documented schema for conversation nodes does NOT include it.
  from?: { id: string; username?: string };
  // The originating top-level post.
  root_post?: { id: string };
  // True if anyone (us, the user manually, anyone) has replied to this node.
  // Used to skip top-level comments that already have a conversation under
  // them so we don't double-reply.
  has_replies?: boolean;
};

/**
 * Fetch the entire conversation tree under a Threads post (or comment).
 * Returns every reply (including nested) the API exposes.
 */
export async function fetchConversation(
  rootPostId: string,
  accessToken: string
): Promise<ThreadsConversationNode[]> {
  // `/conversation` returns ALL replies at every depth (full tree). Used by
  // style-learning to walk our own past replies back to what we replied to.
  // For the comment poller, prefer `fetchReplies` — only top-level comments.
  // Per Meta's docs the `from` object isn't present; author attribution is
  // the flat `username` field on each node.
  const fields =
    "id,text,username,timestamp,replied_to{id},root_post{id}";
  const out = await call<{ data?: ThreadsConversationNode[] }>(
    `/${rootPostId}/conversation`,
    "GET",
    { fields, access_token: accessToken }
  );
  return out.data ?? [];
}

/**
 * Fetch ONLY the top-level replies on a thread (i.e. direct replies to the
 * post itself, not replies-to-replies). This is the right endpoint for a
 * comment auto-reply pipeline — `/conversation` returns the whole nested
 * tree, which we then have to filter back down to top-level anyway.
 * Docs: https://developers.facebook.com/docs/threads/retrieve-and-manage-replies/replies-and-conversations
 */
export async function fetchReplies(
  postId: string,
  accessToken: string
): Promise<ThreadsConversationNode[]> {
  const fields =
    "id,text,username,timestamp,replied_to{id},root_post{id},has_replies";
  const out = await call<{ data?: ThreadsConversationNode[] }>(
    `/${postId}/replies`,
    "GET",
    { fields, access_token: accessToken }
  );
  return out.data ?? [];
}

/**
 * Publish a chain of Threads (a self-reply thread). Each item can carry
 * its own optional media (image / video / carousel). The first item posts
 * as a fresh thread; each subsequent item replies to the previous.
 */
export async function publishChain(
  userId: string,
  accessToken: string,
  items: ThreadsItemSpec[]
): Promise<{ ids: string[] }> {
  if (items.length === 0) throw new ThreadsApiError(400, {}, "chain is empty");
  const ids: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const out = await publishItem(userId, accessToken, {
      ...item,
      replyToId: i > 0 ? ids[i - 1] : undefined,
    });
    ids.push(out.id);
  }
  return { ids };
}
