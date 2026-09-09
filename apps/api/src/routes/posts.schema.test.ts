import { describe, expect, it, vi } from "vitest";

// The route module reaches services -> prisma and the AI client on import.
// None of that runs here; only the request schemas are under test.
vi.mock("@smm/db", () => ({
  prisma: { appSettings: { upsert: vi.fn(async () => ({})) } },
}));

import { CreateBody, UpdateBody } from "./posts.js";

/** A valid IG feed post, spread-and-overridden per case. */
const base = {
  accountId: "acct_1",
  platform: "instagram" as const,
  type: "ig_feed" as const,
  caption: "hostel lights off",
  mediaAssetIds: ["asset_1"],
};

const threads = {
  accountId: "acct_2",
  platform: "threads" as const,
  type: "threads_post" as const,
  mediaAssetIds: [] as string[],
};

describe("CreateBody — caption caps", () => {
  it("accepts an IG caption at the 2200 limit", () => {
    expect(CreateBody.safeParse({ ...base, caption: "x".repeat(2200) }).success).toBe(true);
  });

  it("rejects an IG caption over 2200", () => {
    expect(CreateBody.safeParse({ ...base, caption: "x".repeat(2201) }).success).toBe(false);
  });

  it("accepts a Threads caption at the 500 limit", () => {
    expect(CreateBody.safeParse({ ...threads, caption: "x".repeat(500) }).success).toBe(true);
  });

  // Threads rejects anything over 500 at the API. Catching it here keeps a
  // deterministic failure out of the publish queue, where the retry logic
  // would burn three attempts on something that can never succeed.
  it("rejects a Threads caption over 500", () => {
    const r = CreateBody.safeParse({ ...threads, caption: "x".repeat(501) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("caption"))).toBe(true);
    }
  });

  it("allows an IG-length caption only on IG, not on Threads", () => {
    const long = "x".repeat(1200);
    expect(CreateBody.safeParse({ ...base, caption: long }).success).toBe(true);
    expect(CreateBody.safeParse({ ...threads, caption: long }).success).toBe(false);
  });
});

describe("CreateBody — carousel bounds", () => {
  // Scheduled, so these are publish-intent posts and minimums apply.
  const carousel = (n: number) => ({
    ...base,
    type: "ig_carousel" as const,
    scheduledAt: "2026-09-15T14:30:00.000Z",
    mediaAssetIds: Array.from({ length: n }, (_, i) => `asset_${i}`),
  });

  it.each([2, 3, 10])("accepts a carousel of %i items", (n) => {
    expect(CreateBody.safeParse(carousel(n)).success).toBe(true);
  });

  it.each([0, 1, 11, 20])("rejects a carousel of %i items", (n) => {
    const r = CreateBody.safeParse(carousel(n));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("mediaAssetIds"))).toBe(true);
    }
  });

  // An unscheduled post is still being assembled. Blocking a half-built
  // carousel would mean you cannot save work in progress.
  it("allows a 1-item carousel while it is still a draft", () => {
    const { scheduledAt, ...draft } = carousel(1);
    void scheduledAt;
    expect(CreateBody.safeParse(draft).success).toBe(true);
  });

  it("still rejects an over-full carousel even as a draft", () => {
    const { scheduledAt, ...draft } = carousel(11);
    void scheduledAt;
    expect(CreateBody.safeParse(draft).success).toBe(false);
  });

  it("does not apply carousel bounds to other post types", () => {
    expect(CreateBody.safeParse({ ...base, mediaAssetIds: ["only_one"] }).success).toBe(true);
  });
});

describe("CreateBody — shape", () => {
  it("requires an accountId", () => {
    const { accountId, ...rest } = base;
    void accountId;
    expect(CreateBody.safeParse(rest).success).toBe(false);
  });

  it("rejects an unknown platform or post type", () => {
    expect(CreateBody.safeParse({ ...base, platform: "tiktok" }).success).toBe(false);
    expect(CreateBody.safeParse({ ...base, type: "ig_livestream" }).success).toBe(false);
  });

  it("defaults mediaAssetIds to an empty array", () => {
    const { mediaAssetIds, ...rest } = base;
    void mediaAssetIds;
    const r = CreateBody.safeParse(rest);
    expect(r.success && r.data.mediaAssetIds).toEqual([]);
  });

  it("requires each reply-chain item to carry text or media", () => {
    const chain = (items: unknown[]) =>
      CreateBody.safeParse({
        ...threads,
        type: "threads_reply_chain" as const,
        replyChain: items,
      });
    expect(chain([{ text: "one" }, { text: "two" }]).success).toBe(true);
    // A single filled segment is fine while drafting; the 2-segment minimum
    // only applies once the chain is scheduled.
    expect(chain([{ assetIds: ["a"] }]).success).toBe(true);
    expect(chain([{}]).success).toBe(false);
    expect(chain([{ text: "   " }]).success).toBe(false);
  });

  it("requires 2 segments once a chain is scheduled", () => {
    const scheduled = (items: unknown[]) =>
      CreateBody.safeParse({
        ...threads,
        type: "threads_reply_chain" as const,
        scheduledAt: "2026-09-15T14:30:00.000Z",
        replyChain: items,
      });
    expect(scheduled([{ text: "only one" }]).success).toBe(false);
    expect(scheduled([{ text: "one" }, { text: "two" }]).success).toBe(true);
  });

  it("caps a reply-chain item at 500 chars", () => {
    const r = CreateBody.safeParse({
      ...threads,
      type: "threads_reply_chain" as const,
      replyChain: [{ text: "x".repeat(501) }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range user tag coordinates", () => {
    const tagged = (x: number, y: number) =>
      CreateBody.safeParse({
        ...base,
        assetMetas: [{ assetId: "asset_1", userTags: [{ username: "someone", x, y }] }],
      });
    expect(tagged(0.5, 0.5).success).toBe(true);
    expect(tagged(1.5, 0.5).success).toBe(false);
    expect(tagged(0.5, -0.1).success).toBe(false);
  });

  it("rejects a non-ISO scheduledAt", () => {
    expect(CreateBody.safeParse({ ...base, scheduledAt: "next tuesday" }).success).toBe(false);
    expect(
      CreateBody.safeParse({ ...base, scheduledAt: "2026-09-15T14:30:00.000Z" }).success
    ).toBe(true);
  });
});

// Closed in Phase 3.3. These previously documented a real gap: the hard blocks
// lived only in CreateBody.superRefine, so editing a queued post could set a
// Threads caption Meta will always reject, or break carousel bounds, and the
// result went straight to the publish queue. Both write paths now run the same
// shared validator from @smm/shared.
describe("UpdateBody — hard blocks are enforced on edit too", () => {
  it("rejects a Threads-length-violating caption through PATCH", () => {
    expect(
      UpdateBody.safeParse({ type: "threads_post", caption: "x".repeat(501) }).success
    ).toBe(false);
  });

  it("accepts a Threads caption at the limit", () => {
    expect(
      UpdateBody.safeParse({ type: "threads_post", caption: "x".repeat(500) }).success
    ).toBe(true);
  });

  it("rejects a 1-item carousel on a scheduled PATCH", () => {
    expect(
      UpdateBody.safeParse({
        type: "ig_carousel",
        mediaAssetIds: ["only_one"],
        scheduledAt: "2026-09-15T14:30:00.000Z",
      }).success
    ).toBe(false);
  });

  it("rejects an over-full carousel on any PATCH", () => {
    expect(
      UpdateBody.safeParse({
        type: "ig_carousel",
        mediaAssetIds: Array.from({ length: 11 }, (_, i) => `a${i}`),
      }).success
    ).toBe(false);
  });

  // The schema sees only the patch, so an unscheduled patch reads as a draft
  // even if the stored post is queued. updatePost re-runs the same validator
  // against the MERGED post, which is the authoritative check.
  it("treats an unscheduled patch as a draft at the schema layer", () => {
    expect(
      UpdateBody.safeParse({ type: "ig_carousel", mediaAssetIds: ["only_one"] }).success
    ).toBe(true);
  });

  it("accepts a valid carousel through PATCH", () => {
    expect(
      UpdateBody.safeParse({ type: "ig_carousel", mediaAssetIds: ["a", "b"] }).success
    ).toBe(true);
  });

  it("still enforces the IG 2200 cap", () => {
    expect(UpdateBody.safeParse({ caption: "x".repeat(2201) }).success).toBe(false);
  });

  // Rules are keyed by post type, so a patch that does not change the type has
  // nothing type-specific to check. The merged result is re-validated deeper in
  // updatePost, which knows the row being edited.
  it("skips type-specific rules when the patch omits the type", () => {
    expect(UpdateBody.safeParse({ scheduledAt: null }).success).toBe(true);
  });
});

describe("CreateBody — rules that only the shared table encoded", () => {
  it("rejects a caption on an IG story", () => {
    const r = CreateBody.safeParse({
      ...base,
      type: "ig_story",
      caption: "stories take no caption",
    });
    expect(r.success).toBe(false);
  });

  it("accepts an IG story with no caption", () => {
    const { caption, ...rest } = base;
    void caption;
    expect(CreateBody.safeParse({ ...rest, type: "ig_story" }).success).toBe(true);
  });

  it("rejects a post type that does not belong to the platform", () => {
    const r = CreateBody.safeParse({ ...base, platform: "threads", type: "ig_feed" });
    expect(r.success).toBe(false);
  });
});
