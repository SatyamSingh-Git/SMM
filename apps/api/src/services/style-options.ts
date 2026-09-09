// The visual taxonomy, as data.
//
// Eight dimensions — outfit, shot type, camera, photographer, angle, locale,
// lighting, hairstyle — used to be hardcoded key unions in image-prompts.ts,
// roughly 80 entries describing one creator in one genre. Someone shooting
// surf photography in Portugal shares approximately none of them.
//
// The cache falls back to those constants until the rows load, so behaviour is
// identical before and after seeding. Like cadence and unlike voice this fails
// OPEN: a missing style option produces a less specific prompt, not a wrong
// one, and image generation is human-triggered anyway.

import { prisma } from "@smm/db";
import {
  CAMERA_ANGLE_OPTIONS,
  CAMERA_QUALITY_OPTIONS,
  HAIRSTYLE_OPTIONS,
  LIGHTING_OPTIONS,
  LOCALE_OPTIONS,
  OUTFIT_OPTIONS,
  PHOTOGRAPHER_OPTIONS,
  SHOT_TYPE_OPTIONS,
} from "./image-prompt-options.js";

export type StyleOption = {
  dimension: string;
  key: string;
  label: string;
  promptText: string;
  enabled: boolean;
  sortOrder: number;
  conflictsWith: string[];
};

/** The dimensions the generator knows how to place in a prompt. */
export const BUILT_IN_DIMENSIONS = [
  "outfit",
  "shotType",
  "cameraQuality",
  "photographer",
  "cameraAngle",
  "locale",
  "lighting",
  "hairstyle",
] as const;
export type BuiltInDimension = (typeof BUILT_IN_DIMENSIONS)[number];

const SEED_SOURCE: Record<BuiltInDimension, Record<string, { label: string; phrase: string }>> = {
  outfit: OUTFIT_OPTIONS,
  shotType: SHOT_TYPE_OPTIONS,
  cameraQuality: CAMERA_QUALITY_OPTIONS,
  photographer: PHOTOGRAPHER_OPTIONS,
  cameraAngle: CAMERA_ANGLE_OPTIONS,
  locale: LOCALE_OPTIONS,
  lighting: LIGHTING_OPTIONS,
  hairstyle: HAIRSTYLE_OPTIONS,
};

/** The built-in taxonomy flattened into rows — the seed and the fallback. */
export function builtInOptions(): StyleOption[] {
  const out: StyleOption[] = [];
  for (const dimension of BUILT_IN_DIMENSIONS) {
    const entries = Object.entries(SEED_SOURCE[dimension]);
    entries.forEach(([key, v], i) => {
      out.push({
        dimension,
        key,
        label: v.label,
        promptText: v.phrase,
        enabled: true,
        // Sparse so a row can be dragged between two others without renumbering.
        sortOrder: i * 10,
        conflictsWith: [],
      });
    });
  }
  return out;
}

let cached: StyleOption[] | null = null;

function all(): StyleOption[] {
  return cached ?? builtInOptions();
}

/** Enabled options on a dimension, in display order. */
export function optionsFor(dimension: string): StyleOption[] {
  return all()
    .filter((o) => o.dimension === dimension && o.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}

/**
 * The prompt text for one key, or null.
 *
 * Returns null — never the string "undefined" — for a key that was disabled or
 * removed after a draft referenced it. Callers omit that axis instead, so an
 * old draft degrades to a less specific prompt rather than injecting garbage
 * into a live generation.
 */
export function phraseFor(dimension: string, key: string): string | null {
  const found = all().find(
    (o) => o.dimension === dimension && o.key === key && o.enabled
  );
  return found?.promptText ?? null;
}

export function labelFor(dimension: string, key: string): string | null {
  const found = all().find((o) => o.dimension === dimension && o.key === key);
  return found?.label ?? null;
}

/** Every dimension present, built-in or added later. */
export function dimensions(): string[] {
  return [...new Set(all().map((o) => o.dimension))];
}

export async function refreshStyleOptions(): Promise<void> {
  try {
    const rows = await prisma.styleOption.findMany({
      where: { profileId: "default" },
      orderBy: [{ dimension: "asc" }, { sortOrder: "asc" }],
    });
    // An empty table is not a valid configuration — it would silently strip
    // every director's note from every prompt. Keep the built-ins until the
    // seed has actually run.
    if (rows.length === 0) return;
    cached = rows.map((r) => ({
      dimension: r.dimension,
      key: r.key,
      label: r.label,
      promptText: r.promptText,
      enabled: r.enabled,
      sortOrder: r.sortOrder,
      conflictsWith: r.conflictsWith,
    }));
  } catch (e) {
    console.error("[style-options] refresh failed:", (e as Error).message);
  }
}

/**
 * Insert the built-in taxonomy for any dimension that has no rows yet.
 * Per-dimension rather than all-or-nothing, so adding a new built-in dimension
 * later seeds only that one and leaves edited dimensions untouched.
 */
export async function ensureStyleOptionsSeeded(): Promise<void> {
  const existing = await prisma.styleOption.groupBy({
    by: ["dimension"],
    where: { profileId: "default" },
  });
  const have = new Set(existing.map((e) => e.dimension));
  const missing = builtInOptions().filter((o) => !have.has(o.dimension));
  if (missing.length === 0) return;

  await prisma.styleOption.createMany({
    data: missing.map((o) => ({ profileId: "default", ...o })),
    skipDuplicates: true,
  });
  console.log(
    `[style-options] seeded ${missing.length} options across ${
      new Set(missing.map((o) => o.dimension)).size
    } dimensions`
  );
}

let started = false;
export function startStyleOptions(): void {
  if (started) return;
  started = true;
  void (async () => {
    try {
      await ensureStyleOptionsSeeded();
    } catch (e) {
      console.error("[style-options] seed failed:", (e as Error).message);
    }
    await refreshStyleOptions();
  })();
  const t = setInterval(() => void refreshStyleOptions(), 60_000);
  t.unref();
}

/** Test seam. */
export function __setStyleOptionsForTests(rows: StyleOption[] | null): void {
  cached = rows;
}
