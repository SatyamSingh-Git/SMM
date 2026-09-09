import { describe, expect, it } from "vitest";
import { lintCaption, checkHook } from "./caption-lint";

describe("lintCaption", () => {
  it("passes a caption that sounds like a person", () => {
    expect(lintCaption("hostel lights off, one more scroll and i sleep")).toEqual([]);
  });

  it("returns nothing for empty or whitespace input", () => {
    expect(lintCaption("")).toEqual([]);
    expect(lintCaption("   \n  ")).toEqual([]);
  });

  it("flags corporate words", () => {
    const w = lintCaption("time to elevate your feed");
    expect(w.map((x) => x.kind)).toContain("corporate");
  });

  it("is case-insensitive", () => {
    expect(lintCaption("LEVERAGE this look").map((x) => x.kind)).toContain("corporate");
  });

  // The break in the loop is deliberate — piling five corporate warnings onto
  // one caption trains the user to ignore the panel entirely.
  it("emits at most one corporate warning even with several matches", () => {
    const w = lintCaption("elevate and unlock and leverage your seamless curated feed");
    expect(w.filter((x) => x.kind === "corporate")).toHaveLength(1);
  });

  it("flags engagement bait", () => {
    expect(lintCaption("tag a friend who needs this").map((x) => x.kind)).toContain("bait");
  });

  it("emits at most one bait warning", () => {
    const w = lintCaption("comment yes and tag a friend and follow for more");
    expect(w.filter((x) => x.kind === "bait")).toHaveLength(1);
  });

  it("can flag corporate and bait together", () => {
    const kinds = lintCaption("unlock your best self — tag a friend").map((x) => x.kind);
    expect(kinds).toContain("corporate");
    expect(kinds).toContain("bait");
  });

  it("flags 4+ emojis stacked at the end", () => {
    expect(lintCaption("goa mornings 🌊🌴✨💫").map((x) => x.kind)).toContain("emoji-clump");
  });

  it("allows 3 trailing emojis", () => {
    expect(lintCaption("goa mornings 🌊🌴✨").map((x) => x.kind)).not.toContain("emoji-clump");
  });

  it("allows emojis spread through the line", () => {
    const kinds = lintCaption("🌊 goa ✨ mornings 🌴 hit different 💫 fr").map((x) => x.kind);
    expect(kinds).not.toContain("emoji-clump");
  });
});

describe("checkHook", () => {
  const short = "one line, well under the fold";
  const long = "x".repeat(200);

  it("returns nothing for an empty caption", () => {
    expect(checkHook("", "instagram", "ig_feed")).toEqual([]);
  });

  it("marks a reel hook good under 55 chars", () => {
    const [badge] = checkHook(short, "instagram", "ig_reel");
    expect(badge?.tone).toBe("good");
    expect(badge?.label).toContain("/55");
  });

  it("warns when a reel hook passes the 55-char fold", () => {
    const [badge] = checkHook("y".repeat(56), "instagram", "ig_reel");
    expect(badge?.tone).toBe("warn");
  });

  it("uses the 125-char fold for feed posts", () => {
    const [badge] = checkHook(short, "instagram", "ig_feed");
    expect(badge?.label).toContain("/125");
  });

  it("warns when a feed hook passes 125 chars", () => {
    expect(checkHook(long, "instagram", "ig_feed")[0]?.tone).toBe("warn");
  });

  // Threads shows short posts whole, so a length badge there would be noise.
  it("emits no length badge for threads", () => {
    expect(checkHook(long, "threads", "threads_post").some((b) => b.label.includes("/"))).toBe(
      false
    );
  });

  it("flags a bait phrase in the hook on any platform", () => {
    const labels = checkHook("tag a friend", "threads", "threads_post").map((b) => b.label);
    expect(labels).toContain("bait phrase in hook");
  });

  it("only looks at the first line", () => {
    const [badge] = checkHook(`${short}\n${long}`, "instagram", "ig_feed");
    expect(badge?.tone).toBe("good");
  });
});
