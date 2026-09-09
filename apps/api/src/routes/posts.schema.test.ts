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
  const carousel = (n: number) => ({
    ...base,
    type: "ig_carousel" as const,
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
    expect(chain([{ assetIds: ["a"] }]).success).toBe(true);
    expect(chain([{}]).success).toBe(false);
    expect(chain([{ text: "   " }]).success).toBe(false);
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

// Documents a real gap rather than asserting desired behaviour: the hard blocks
// live in CreateBody.superRefine, which PATCH does not run. Editing a queued
// post can therefore set a Threads caption Meta will reject, or break carousel
// bounds. Phase 3.3 moves these rules into one shared table used by both; when
// that lands, these expectations flip to `false` and the tests move up into the
// CreateBody blocks above.
describe("UpdateBody — known gap: hard blocks are not enforced on edit", () => {
  it("currently allows a Threads-length-violating caption through PATCH", () => {
    expect(UpdateBody.safeParse({ caption: "x".repeat(501) }).success).toBe(true);
  });

  it("currently allows a 1-item carousel through PATCH", () => {
    expect(
      UpdateBody.safeParse({ type: "ig_carousel", mediaAssetIds: ["only_one"] }).success
    ).toBe(true);
  });

  it("still enforces the IG 2200 cap it shares with CreateBody", () => {
    expect(UpdateBody.safeParse({ caption: "x".repeat(2201) }).success).toBe(false);
  });
});
