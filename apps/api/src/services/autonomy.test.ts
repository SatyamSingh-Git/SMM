import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@smm/db", () => ({
  prisma: { profile: { findUnique: vi.fn() }, appSettings: { upsert: vi.fn(async () => ({})) } },
}));

import { __setProfileForTests } from "./profile/resolver.js";
import { seedProfile } from "./profile/seed.js";
import {
  AUTONOMY_DEFAULTS,
  atLeast,
  autonomySnapshot,
  decide,
  isEnabled,
  levelFor,
  runsUnattended,
} from "./autonomy.js";
import type { AutonomyLevel, AutonomyStage } from "./profile/types.js";

const STAGES = Object.keys(AUTONOMY_DEFAULTS) as AutonomyStage[];

function withPolicy(autonomy: Partial<Record<AutonomyStage, AutonomyLevel>>) {
  __setProfileForTests({ ...seedProfile(), policy: { autonomy } });
}

beforeEach(() => __setProfileForTests(null));

describe("defaults", () => {
  // The defaults are today's behaviour written down: publishing and replying
  // already run unattended, nothing else exists yet. If this test changes,
  // something started or stopped running on its own.
  it("matches the behaviour the system already had", () => {
    expect(AUTONOMY_DEFAULTS).toEqual({
      plan: "off",
      generate_media: "off",
      write_caption: "off",
      schedule: "off",
      publish: "auto",
      reply: "auto",
      learn: "auto",
    });
  });

  it("falls back to defaults when no profile is loaded", () => {
    expect(levelFor("publish")).toBe("auto");
    expect(levelFor("plan")).toBe("off");
  });

  it("falls back per stage when the policy only sets some", () => {
    withPolicy({ plan: "suggest" });
    expect(levelFor("plan")).toBe("suggest");
    expect(levelFor("publish")).toBe("auto"); // untouched, still the default
  });
});

describe("reading a level", () => {
  it("uses the configured level over the default", () => {
    withPolicy({ publish: "review" });
    expect(levelFor("publish")).toBe("review");
  });

  it.each(["off", "suggest", "review", "auto"] as const)("round-trips %s", (level) => {
    withPolicy({ plan: level });
    expect(levelFor("plan")).toBe(level);
  });
});

describe("predicates", () => {
  it("isEnabled is false only for off", () => {
    withPolicy({ plan: "off" });
    expect(isEnabled("plan")).toBe(false);
    for (const level of ["suggest", "review", "auto"] as const) {
      withPolicy({ plan: level });
      expect(isEnabled("plan")).toBe(true);
    }
  });

  it("runsUnattended is true only for auto", () => {
    for (const level of ["off", "suggest", "review"] as const) {
      withPolicy({ publish: level });
      expect(runsUnattended("publish")).toBe(false);
    }
    withPolicy({ publish: "auto" });
    expect(runsUnattended("publish")).toBe(true);
  });

  it("atLeast orders off < suggest < review < auto", () => {
    withPolicy({ plan: "review" });
    expect(atLeast("plan", "off")).toBe(true);
    expect(atLeast("plan", "suggest")).toBe(true);
    expect(atLeast("plan", "review")).toBe(true);
    expect(atLeast("plan", "auto")).toBe(false);
  });
});

describe("decide", () => {
  it.each([
    ["off", "skip"],
    ["suggest", "draft"],
    ["review", "gate"],
    ["auto", "proceed"],
  ] as const)("maps %s to %s", (level, act) => {
    withPolicy({ write_caption: level });
    expect(decide("write_caption")).toEqual({ act, level });
  });

  // Callers switch on `act`, so every level must map to one — a level with no
  // mapping would fall through and the stage would silently do nothing.
  it("returns an act for every stage under the defaults", () => {
    for (const stage of STAGES) {
      expect(decide(stage).act).toBeTruthy();
    }
  });
});

describe("autonomySnapshot", () => {
  it("reports every stage", () => {
    expect(Object.keys(autonomySnapshot()).sort()).toEqual([...STAGES].sort());
  });

  it("blends configured levels with defaults", () => {
    withPolicy({ plan: "suggest", publish: "review" });
    const snap = autonomySnapshot();
    expect(snap.plan).toBe("suggest");
    expect(snap.publish).toBe("review");
    expect(snap.reply).toBe("auto");
  });
});
