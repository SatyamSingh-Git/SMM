import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@smm/db", () => ({
  prisma: {
    styleOption: { findMany: vi.fn(), groupBy: vi.fn(), createMany: vi.fn() },
    appSettings: { upsert: vi.fn(async () => ({})) },
  },
}));

import { getOptionCatalog } from "./image-prompts.js";
import {
  BUILT_IN_DIMENSIONS,
  __setStyleOptionsForTests,
  builtInOptions,
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

afterEach(() => __setStyleOptionsForTests(null));

describe("getOptionCatalog", () => {
  // The composer used to read a fixed eight-key object. It now reads whatever
  // dimensions exist, which is what lets a new axis appear without a code
  // change — but the eight built-ins must still be there or the existing UI
  // loses its pickers.
  it("still exposes every built-in dimension", () => {
    const catalog = getOptionCatalog();
    for (const d of BUILT_IN_DIMENSIONS) {
      expect(catalog[d], d).toBeDefined();
      expect(catalog[d]!.length).toBeGreaterThan(0);
    }
  });

  it("matches the built-in taxonomy before anything loads", () => {
    const catalog = getOptionCatalog();
    const outfits = builtInOptions().filter((o) => o.dimension === "outfit");
    expect(catalog.outfit!.map((o) => o.value)).toEqual(outfits.map((o) => o.key));
  });

  it("carries value, label and conflicts for each option", () => {
    __setStyleOptionsForTests([
      opt({ key: "studio", label: "Studio", conflictsWith: ["golden_hour"] }),
    ]);
    expect(getOptionCatalog().outfit).toEqual([
      { value: "studio", label: "Studio", conflictsWith: ["golden_hour"] },
    ]);
  });

  it("includes a dimension the code has never heard of", () => {
    __setStyleOptionsForTests([opt({ dimension: "season", key: "monsoon" })]);
    expect(getOptionCatalog().season).toEqual([
      { value: "monsoon", label: "L", conflictsWith: [] },
    ]);
  });

  it("omits disabled options", () => {
    __setStyleOptionsForTests([
      opt({ key: "live" }),
      opt({ key: "retired", enabled: false }),
    ]);
    expect(getOptionCatalog().outfit!.map((o) => o.value)).toEqual(["live"]);
  });

  it("omits a dimension whose options are all disabled", () => {
    __setStyleOptionsForTests([opt({ key: "retired", enabled: false })]);
    expect(getOptionCatalog().outfit).toEqual([]);
  });
});
