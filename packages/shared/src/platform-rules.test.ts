import { describe, expect, it } from "vitest";
import {
  CHAIN_ITEM_MAX,
  PLATFORM_RULES,
  TYPES_BY_PLATFORM,
  captionMaxFor,
  mimeAllowed,
  validatePost,
  type PostType,
} from "./platform-rules.js";

const ALL_TYPES = Object.keys(PLATFORM_RULES) as PostType[];

describe("the rules table", () => {
  it("covers every type listed under a platform, and no others", () => {
    const listed = [...TYPES_BY_PLATFORM.instagram, ...TYPES_BY_PLATFORM.threads].sort();
    expect(listed).toEqual([...ALL_TYPES].sort());
  });

  it("files each type under its own platform", () => {
    for (const [platform, types] of Object.entries(TYPES_BY_PLATFORM)) {
      for (const t of types) expect(PLATFORM_RULES[t].platform).toBe(platform);
    }
  });

  it("keeps min <= max media for every type", () => {
    for (const t of ALL_TYPES) {
      expect(PLATFORM_RULES[t].minMedia).toBeLessThanOrEqual(PLATFORM_RULES[t].maxMedia);
    }
  });

  // These are the numbers that used to live in two places. Pinning them here
  // is what makes the composer and the API provably agree.
  it.each([
    ["ig_feed", 2200],
    ["ig_reel", 2200],
    ["ig_carousel", 2200],
    ["ig_story", 0],
    ["threads_post", 500],
  ] as const)("caps %s captions at %i", (type, max) => {
    expect(captionMaxFor(type)).toBe(max);
  });

  it("declares no media types for a type that takes no media", () => {
    expect(PLATFORM_RULES.threads_reply_chain.mimeTypes).toEqual([]);
  });
});

describe("validatePost — caption caps", () => {
  it("accepts a caption at the limit", () => {
    expect(validatePost({ type: "ig_feed", caption: "x".repeat(2200) })).toEqual([]);
  });

  it("rejects a caption over the limit and says by how much", () => {
    const [v] = validatePost({ type: "threads_post", caption: "x".repeat(501) });
    expect(v?.field).toBe("caption");
    expect(v?.message).toContain("501");
  });

  it("rejects any caption on a type that takes none", () => {
    expect(validatePost({ type: "ig_story", caption: "hi" })).toHaveLength(1);
    expect(validatePost({ type: "ig_story", caption: "" })).toEqual([]);
    expect(validatePost({ type: "ig_story", caption: "   " })).toEqual([]);
  });
});

describe("validatePost — media bounds", () => {
  it("accepts a carousel inside its bounds", () => {
    expect(validatePost({ type: "ig_carousel", mediaCount: 5 })).toEqual([]);
  });

  it.each([1, 11])("rejects a carousel of %i when publishing", (n) => {
    expect(validatePost({ type: "ig_carousel", mediaCount: n })).toHaveLength(1);
  });

  // A post still being assembled may be incomplete; blocking that would mean
  // you cannot save work in progress.
  it("allows too-few items while drafting", () => {
    expect(validatePost({ type: "ig_carousel", mediaCount: 1, stage: "draft" })).toEqual([]);
    expect(validatePost({ type: "ig_feed", mediaCount: 0, stage: "draft" })).toEqual([]);
  });

  // Too MANY is wrong whenever you look at it — it is not an unfinished state.
  it("rejects too-many items even while drafting", () => {
    expect(
      validatePost({ type: "ig_carousel", mediaCount: 11, stage: "draft" })
    ).toHaveLength(1);
  });

  it("defaults to the stricter publish reading when no stage is given", () => {
    expect(validatePost({ type: "ig_feed", mediaCount: 0 })).toHaveLength(1);
  });

  it("skips media checks entirely when the count is unknown", () => {
    expect(validatePost({ type: "ig_carousel" })).toEqual([]);
  });
});

describe("validatePost — reply chains", () => {
  const chain = (items: Array<{ text?: string; assetCount?: number }>, stage?: "draft") =>
    validatePost({ type: "threads_reply_chain", chainItems: items, stage });

  it("accepts a two-segment chain", () => {
    expect(chain([{ text: "one" }, { text: "two" }])).toEqual([]);
  });

  it("requires two segments when publishing", () => {
    expect(chain([{ text: "only one" }])).toHaveLength(1);
  });

  it("allows a one-segment chain while drafting", () => {
    expect(chain([{ text: "just started" }], "draft")).toEqual([]);
  });

  it("counts a media-only segment as filled", () => {
    expect(chain([{ assetCount: 1 }, { text: "two" }])).toEqual([]);
  });

  it("does not count a whitespace-only segment", () => {
    expect(chain([{ text: "   " }, { text: "two" }])).toHaveLength(1);
  });

  it("rejects an over-long segment at either stage", () => {
    const long = [{ text: "x".repeat(CHAIN_ITEM_MAX + 1) }, { text: "two" }];
    expect(chain(long)).toHaveLength(1);
    expect(chain(long, "draft")).toHaveLength(1);
  });
});

describe("validatePost — platform mismatch", () => {
  it("rejects an IG type declared as Threads", () => {
    const [v] = validatePost({ type: "ig_feed", platform: "threads", mediaCount: 1 });
    expect(v?.field).toBe("type");
  });

  it("accepts a type on its own platform", () => {
    expect(validatePost({ type: "ig_feed", platform: "instagram", mediaCount: 1 })).toEqual(
      []
    );
  });

  it("skips the check when no platform is supplied", () => {
    expect(validatePost({ type: "ig_feed", mediaCount: 1 })).toEqual([]);
  });
});

describe("mimeAllowed", () => {
  it("accepts JPEG on a feed post but not MP4", () => {
    expect(mimeAllowed("ig_feed", "image/jpeg")).toBe(true);
    expect(mimeAllowed("ig_feed", "video/mp4")).toBe(false);
  });

  // PNG-to-Instagram is one of the deterministic rejections this table exists
  // to catch — the composer converts to JPEG client-side, and anything that
  // slips past that should fail here rather than at Meta.
  it("rejects PNG everywhere", () => {
    for (const t of ALL_TYPES) expect(mimeAllowed(t, "image/png")).toBe(false);
  });

  it("accepts MP4 on a reel but not JPEG", () => {
    expect(mimeAllowed("ig_reel", "video/mp4")).toBe(true);
    expect(mimeAllowed("ig_reel", "image/jpeg")).toBe(false);
  });
});
