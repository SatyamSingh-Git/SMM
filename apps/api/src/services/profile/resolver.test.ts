import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const create = vi.fn();
const update = vi.fn();
vi.mock("@smm/db", () => ({
  prisma: {
    profile: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
    },
    appSettings: { upsert: vi.fn(async () => ({})) },
  },
}));

import {
  __setProfileForTests,
  backfillProfileDefaults,
  ensureProfileSeeded,
  getProfile,
  parseProfileRow,
  refreshProfile,
  requireProfile,
} from "./resolver.js";
import { seedProfile } from "./seed.js";

const seed = seedProfile();

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "default",
    name: "Default",
    version: 3,
    identityJson: seed.identity,
    voiceJson: seed.voice,
    visualJson: seed.visual,
    cadenceJson: seed.cadence,
    policyJson: seed.policy,
    ...overrides,
  };
}

beforeEach(() => {
  __setProfileForTests(null);
  findUnique.mockReset();
  create.mockReset();
  update.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// The single most important property in this module. runtime-config fails OPEN
// because a default reply cap is harmless. A default PERSONA is not: a worker
// tick during the boot window would generate a reply in the wrong voice and
// publish it, and there is no undo on a published reply.
describe("fails closed", () => {
  it("returns null before anything is loaded", () => {
    expect(getProfile()).toBeNull();
  });

  it("stays null when the row does not exist yet", async () => {
    findUnique.mockResolvedValue(null);
    await refreshProfile();
    expect(getProfile()).toBeNull();
  });

  it("stays null when the database throws", async () => {
    findUnique.mockRejectedValue(new Error("connection refused"));
    await refreshProfile();
    expect(getProfile()).toBeNull();
  });

  it("stays null when the stored row is malformed", async () => {
    findUnique.mockResolvedValue(row({ voiceJson: { caption: "only one block" } }));
    await refreshProfile();
    expect(getProfile()).toBeNull();
  });

  // A bad write must not silently revert the account to a built-in voice.
  it("keeps the last good profile rather than reverting on a later failure", async () => {
    findUnique.mockResolvedValue(row());
    await refreshProfile();
    expect(getProfile()?.version).toBe(3);

    findUnique.mockRejectedValue(new Error("transient"));
    await refreshProfile();
    expect(getProfile()?.version).toBe(3);
  });

  it("requireProfile throws rather than inventing one", () => {
    expect(() => requireProfile()).toThrow(/not loaded/i);
  });
});

describe("loading", () => {
  it("parses a well-formed row", async () => {
    findUnique.mockResolvedValue(row());
    await refreshProfile();
    const p = getProfile();
    expect(p?.identity.handle).toBe(seed.identity.handle);
    expect(Object.keys(p!.voice)).toHaveLength(5);
  });

  it("requireProfile returns the loaded profile", async () => {
    findUnique.mockResolvedValue(row());
    await refreshProfile();
    expect(requireProfile().version).toBe(3);
  });

  it("rejects a row missing a voice block", () => {
    expect(() => parseProfileRow(row({ voiceJson: {} }))).toThrow();
  });

  it("rejects a row with an empty handle", () => {
    expect(() =>
      parseProfileRow(row({ identityJson: { ...seed.identity, handle: "" } }))
    ).toThrow();
  });

  it("fills defaults for optional identity fields", () => {
    const p = parseProfileRow(row({ identityJson: { handle: "someone" } }));
    expect(p.identity.languages).toEqual([]);
    expect(p.identity.niche).toBe("");
  });
});

describe("seeding", () => {
  it("creates the default row when none exists", async () => {
    findUnique.mockResolvedValue(null);
    await ensureProfileSeeded();
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]![0].data;
    expect(data.id).toBe("default");
    expect(data.version).toBe(1);
  });

  // A redeploy must never clobber an edited voice with the factory default.
  it("does nothing when a row already exists", async () => {
    findUnique.mockResolvedValue(row());
    await ensureProfileSeeded();
    expect(create).not.toHaveBeenCalled();
  });
});

// A field added to the schema after the row was seeded reads as its zod
// default, which for toneBias means the block it controls silently stops being
// emitted — no error, no log, just a quietly different prompt. This is the
// forward-fill that stops that happening again.
describe("backfilling fields added after seeding", () => {
  it("fills toneBias when the key is absent", async () => {
    findUnique.mockResolvedValue(row({ visualJson: { subjectDescriptor: "d" } }));
    await backfillProfileDefaults();
    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0]![0].data.visualJson;
    expect(data.subjectDescriptor).toBe("d");
    expect(data.toneBias.length).toBeGreaterThan(0);
  });

  // Present-but-empty means the user cleared it on purpose.
  it("respects a deliberately emptied toneBias", async () => {
    findUnique.mockResolvedValue(
      row({ visualJson: { subjectDescriptor: "d", toneBias: "" } })
    );
    await backfillProfileDefaults();
    expect(update).not.toHaveBeenCalled();
  });

  it("does nothing when the field is already set", async () => {
    findUnique.mockResolvedValue(
      row({ visualJson: { subjectDescriptor: "d", toneBias: "mine" } })
    );
    await backfillProfileDefaults();
    expect(update).not.toHaveBeenCalled();
  });

  it("does nothing when there is no profile row yet", async () => {
    findUnique.mockResolvedValue(null);
    await backfillProfileDefaults();
    expect(update).not.toHaveBeenCalled();
  });
});
