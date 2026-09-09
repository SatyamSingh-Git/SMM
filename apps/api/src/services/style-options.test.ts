import { afterEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@smm/db", () => ({
  prisma: {
    styleOption: {
      findMany: (...a: unknown[]) => findMany(...a),
      groupBy: vi.fn(),
      createMany: vi.fn(),
    },
    appSettings: { upsert: vi.fn(async () => ({})) },
  },
}));

import {
  BUILT_IN_DIMENSIONS,
  __setStyleOptionsForTests,
  builtInOptions,
  dimensions,
  labelFor,
  refreshStyleOptions,
  optionsFor,
  phraseFor,
  type StyleOption,
} from "./style-options.js";

const opt = (over: Partial<StyleOption> = {}): StyleOption => ({
  dimension: "outfit",
  key: "k",
  label: "L",
  promptText: "some direction",
  enabled: true,
  sortOrder: 0,
  conflictsWith: [],
  ...over,
});

afterEach(() => {
  __setStyleOptionsForTests(null);
  findMany.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("the built-in taxonomy", () => {
  it("covers every declared dimension", () => {
    const seen = new Set(builtInOptions().map((o) => o.dimension));
    expect([...seen].sort()).toEqual([...BUILT_IN_DIMENSIONS].sort());
  });

  it("gives every option a key, label and prompt text", () => {
    for (const o of builtInOptions()) {
      expect(o.key, JSON.stringify(o)).toMatch(/^[a-z0-9_]+$/);
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.promptText.length).toBeGreaterThan(10);
    }
  });

  it("keys are unique within a dimension", () => {
    const seen = new Set<string>();
    for (const o of builtInOptions()) {
      const id = `${o.dimension}/${o.key}`;
      expect(seen.has(id), `duplicate ${id}`).toBe(false);
      seen.add(id);
    }
  });

  // Sparse ordering so a row can be dragged between two neighbours without
  // renumbering the whole dimension.
  it("spaces sortOrder so rows can be reordered without renumbering", () => {
    const outfits = builtInOptions().filter((o) => o.dimension === "outfit");
    const orders = outfits.map((o) => o.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]! - orders[i - 1]!).toBeGreaterThan(1);
    }
  });
});

describe("falling back to the built-ins", () => {
  it("serves the built-in taxonomy before anything loads", () => {
    expect(optionsFor("outfit").length).toBeGreaterThan(0);
    expect(dimensions().sort()).toEqual([...BUILT_IN_DIMENSIONS].sort());
  });

  it("resolves a built-in key to its prompt text", () => {
    const first = builtInOptions()[0]!;
    expect(phraseFor(first.dimension, first.key)).toBe(first.promptText);
    expect(labelFor(first.dimension, first.key)).toBe(first.label);
  });
});

describe("reading loaded options", () => {
  it("returns them in sortOrder", () => {
    __setStyleOptionsForTests([
      opt({ key: "third", sortOrder: 30 }),
      opt({ key: "first", sortOrder: 10 }),
      opt({ key: "second", sortOrder: 20 }),
    ]);
    expect(optionsFor("outfit").map((o) => o.key)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("breaks sortOrder ties by key, so the order is never arbitrary", () => {
    __setStyleOptionsForTests([
      opt({ key: "b", sortOrder: 0 }),
      opt({ key: "a", sortOrder: 0 }),
    ]);
    expect(optionsFor("outfit").map((o) => o.key)).toEqual(["a", "b"]);
  });

  it("keeps dimensions separate", () => {
    __setStyleOptionsForTests([
      opt({ dimension: "outfit", key: "a" }),
      opt({ dimension: "lighting", key: "b" }),
    ]);
    expect(optionsFor("outfit").map((o) => o.key)).toEqual(["a"]);
    expect(optionsFor("lighting").map((o) => o.key)).toEqual(["b"]);
  });

  // A dimension the code has never heard of must work, or "add a new axis"
  // means shipping a migration and the taxonomy is only parameterized, not
  // configurable.
  it("supports a dimension that is not built in", () => {
    __setStyleOptionsForTests([opt({ dimension: "season", key: "monsoon" })]);
    expect(optionsFor("season").map((o) => o.key)).toEqual(["monsoon"]);
    expect(dimensions()).toContain("season");
  });

  it("returns nothing for an unknown dimension", () => {
    __setStyleOptionsForTests([opt()]);
    expect(optionsFor("nope")).toEqual([]);
  });
});

describe("disabled options", () => {
  it("hides them from the picker", () => {
    __setStyleOptionsForTests([
      opt({ key: "live" }),
      opt({ key: "retired", enabled: false }),
    ]);
    expect(optionsFor("outfit").map((o) => o.key)).toEqual(["live"]);
  });

  // The whole reason delete is a soft delete: a saved draft still references
  // the key, and resolving it to the string "undefined" would inject garbage
  // into a live generation. null means "omit this axis".
  it("resolves a disabled key to null, never to a broken string", () => {
    __setStyleOptionsForTests([opt({ key: "retired", enabled: false })]);
    expect(phraseFor("outfit", "retired")).toBeNull();
  });

  it("resolves a key that was removed entirely to null", () => {
    __setStyleOptionsForTests([opt({ key: "live" })]);
    expect(phraseFor("outfit", "gone")).toBeNull();
    expect(phraseFor("nope", "gone")).toBeNull();
  });

  // labelFor still answers for a disabled row so the UI can show what an old
  // draft was referring to, instead of an empty chip.
  it("still labels a disabled key", () => {
    __setStyleOptionsForTests([
      opt({ key: "retired", label: "Retired look", enabled: false }),
    ]);
    expect(labelFor("outfit", "retired")).toBe("Retired look");
  });
});

describe("refreshing from the database", () => {
  it("replaces the cache with the stored rows", async () => {
    findMany.mockResolvedValue([
      { ...opt({ dimension: "season", key: "monsoon" }), id: "1", profileId: "default" },
    ]);
    await refreshStyleOptions();
    expect(dimensions()).toEqual(["season"]);
  });

  // An empty table is not a valid configuration — it means the seed has not run
  // yet. Accepting it would silently strip every director's note from every
  // prompt: no error, no log, just quietly worse output.
  it("keeps the built-ins when the table is empty", async () => {
    findMany.mockResolvedValue([]);
    await refreshStyleOptions();
    expect(dimensions().sort()).toEqual([...BUILT_IN_DIMENSIONS].sort());
  });

  it("keeps the last good cache when the query throws", async () => {
    findMany.mockResolvedValue([
      { ...opt({ dimension: "season", key: "monsoon" }), id: "1", profileId: "default" },
    ]);
    await refreshStyleOptions();
    findMany.mockRejectedValue(new Error("connection refused"));
    await refreshStyleOptions();
    expect(dimensions()).toEqual(["season"]);
  });
});
