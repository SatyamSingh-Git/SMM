// The one place platform limits are written down.
//
// These are Meta's rules, not preferences — 2200 characters is a fact about
// Instagram, and making it "configurable" would only let someone configure
// their way into a guaranteed API rejection. Creator preferences that sit on
// top (favoured caption length, emoji policy, bait-phrase list) belong in the
// profile's policy blob, not here.
//
// Lives in a shared package because it was previously written twice: once in
// the composer UI and once in the create-post validator, with no mechanism
// keeping them equal. The edit path had only the UI copy, which is how a
// PATCH could set a Threads caption Meta will always reject.

export type Platform = "instagram" | "threads";

export type PostType =
  | "ig_feed"
  | "ig_carousel"
  | "ig_reel"
  | "ig_story"
  | "threads_post"
  | "threads_reply_chain";

export type MediaShape = "none" | "single-image" | "single-video" | "single-any" | "multi";

export type PostTypeRule = {
  platform: Platform;
  /** 0 means the type carries no caption at all (IG Stories). */
  captionMax: number;
  media: MediaShape;
  /** Inclusive bounds on attached media. */
  minMedia: number;
  maxMedia: number;
  /** Threads self-reply chains. */
  chain: boolean;
  /** First-line characters visible before the "more" fold. 0 = not truncated. */
  hookCutoff: number;
  /** Accepted mime types; empty means "no media on this type". */
  mimeTypes: string[];
};

const IMAGE = ["image/jpeg"];
const VIDEO = ["video/mp4"];
const EITHER = [...IMAGE, ...VIDEO];

export const PLATFORM_RULES: Record<PostType, PostTypeRule> = {
  ig_feed: {
    platform: "instagram",
    captionMax: 2200,
    media: "single-image",
    minMedia: 1,
    maxMedia: 1,
    chain: false,
    hookCutoff: 125,
    mimeTypes: IMAGE,
  },
  ig_reel: {
    platform: "instagram",
    captionMax: 2200,
    media: "single-video",
    minMedia: 1,
    maxMedia: 1,
    chain: false,
    // Reels truncate hardest — roughly half of what a feed post shows.
    hookCutoff: 55,
    mimeTypes: VIDEO,
  },
  ig_carousel: {
    platform: "instagram",
    captionMax: 2200,
    media: "multi",
    minMedia: 2,
    maxMedia: 10,
    chain: false,
    hookCutoff: 125,
    mimeTypes: EITHER,
  },
  ig_story: {
    platform: "instagram",
    captionMax: 0,
    media: "single-any",
    minMedia: 1,
    maxMedia: 1,
    chain: false,
    hookCutoff: 0,
    mimeTypes: EITHER,
  },
  threads_post: {
    platform: "threads",
    captionMax: 500,
    media: "multi",
    minMedia: 0,
    maxMedia: 20,
    chain: false,
    // Threads shows short posts whole, so there is no fold to fit.
    hookCutoff: 0,
    mimeTypes: EITHER,
  },
  threads_reply_chain: {
    platform: "threads",
    captionMax: 0,
    media: "none",
    minMedia: 0,
    maxMedia: 0,
    chain: true,
    hookCutoff: 0,
    mimeTypes: [],
  },
};

export const TYPES_BY_PLATFORM: Record<Platform, PostType[]> = {
  instagram: ["ig_feed", "ig_reel", "ig_carousel", "ig_story"],
  threads: ["threads_post", "threads_reply_chain"],
};

/** Per-item cap inside a Threads reply chain. */
export const CHAIN_ITEM_MAX = 500;
export const CHAIN_MAX_ITEMS = 20;

export function ruleFor(type: PostType): PostTypeRule {
  return PLATFORM_RULES[type];
}

export function captionMaxFor(type: PostType): number {
  return PLATFORM_RULES[type].captionMax;
}

/**
 * A post still being composed may legitimately be incomplete — no image chosen
 * yet, one slide of a planned carousel, the first line of a chain. Minimums
 * only become errors once the post is headed for the queue.
 *
 * Maximums, caption caps and type/platform mismatches apply at BOTH stages:
 * those are wrong no matter when you look at them.
 */
export type PostStage = "draft" | "publish";

export type PostShape = {
  type: PostType;
  platform?: Platform;
  caption?: string | null;
  mediaCount?: number;
  chainItems?: Array<{ text?: string | null; assetCount?: number }> | null;
  /** Defaults to "publish" — the stricter reading. */
  stage?: PostStage;
};

export type RuleViolation = { field: string; message: string };

/**
 * Every deterministic reason Meta would reject this post. Returns [] when the
 * post is publishable as far as these rules can tell.
 *
 * Applied on create AND on edit. The publish retry exists for TRANSIENT
 * failures; a post that violates one of these can never succeed, so letting it
 * reach the queue just burns three attempts and leaves a failed row.
 */
export function validatePost(post: PostShape): RuleViolation[] {
  const stage: PostStage = post.stage ?? "publish";
  const rule = PLATFORM_RULES[post.type];
  const out: RuleViolation[] = [];
  if (!rule) return [{ field: "type", message: `unknown post type ${post.type}` }];

  if (post.platform && post.platform !== rule.platform) {
    out.push({
      field: "type",
      message: `${post.type} is a ${rule.platform} type, not ${post.platform}`,
    });
  }

  const caption = post.caption ?? "";
  if (rule.captionMax === 0) {
    if (caption.trim().length > 0 && !rule.chain) {
      out.push({ field: "caption", message: `${post.type} does not accept a caption` });
    }
  } else if (caption.length > rule.captionMax) {
    out.push({
      field: "caption",
      message: `caption must be ≤${rule.captionMax} characters for ${post.type} (got ${caption.length})`,
    });
  }

  if (post.mediaCount !== undefined) {
    const tooFew = stage === "publish" && post.mediaCount < rule.minMedia;
    const tooMany = post.mediaCount > rule.maxMedia;
    if (tooFew || tooMany) {
      out.push({
        field: "mediaAssetIds",
        message:
          rule.minMedia === rule.maxMedia
            ? `${post.type} needs exactly ${rule.minMedia} item(s) (got ${post.mediaCount})`
            : `${post.type} needs ${rule.minMedia}–${rule.maxMedia} items (got ${post.mediaCount})`,
      });
    }
  }

  if (rule.chain && post.chainItems) {
    const filled = post.chainItems.filter(
      (c) => (c.text ?? "").trim().length > 0 || (c.assetCount ?? 0) > 0
    );
    if (stage === "publish" && filled.length < 2) {
      out.push({ field: "replyChain", message: "a chain needs at least 2 segments" });
    }
    if (filled.length > CHAIN_MAX_ITEMS) {
      out.push({
        field: "replyChain",
        message: `a chain can have at most ${CHAIN_MAX_ITEMS} segments`,
      });
    }
    if (post.chainItems.some((c) => (c.text ?? "").length > CHAIN_ITEM_MAX)) {
      out.push({
        field: "replyChain",
        message: `each chain segment must be ≤${CHAIN_ITEM_MAX} characters`,
      });
    }
  }

  return out;
}

/** Is this mime acceptable for this post type? */
export function mimeAllowed(type: PostType, mimeType: string): boolean {
  return PLATFORM_RULES[type].mimeTypes.includes(mimeType);
}
