import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@smm/db";
import {
  CadenceSchema,
  IdentitySchema,
  PolicySchema,
  VisualSchema,
  VoiceSchema,
  MIN_QUIET_HOURS_PER_DAY,
  quietHoursPerDay,
  unknownPlaceholders,
  type Voice,
} from "../services/profile/types.js";
import { parseProfileRow, refreshProfile } from "../services/profile/resolver.js";
import { composeSystemPrompt } from "../services/prompt/compose.js";
import { isValidTimeZone } from "../services/tz.js";

// The Profile is what used to be hardcoded prompt constants. Editing it
// changes what the account sounds like, so every write snapshots the previous
// state into ProfileVersion first — voice config is free text feeding an LLM
// that publishes to a real account, and you will eventually make an edit that
// makes replies worse.

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  identity: IdentitySchema.partial().optional(),
  voice: VoiceSchema.partial().optional(),
  visual: VisualSchema.partial().optional(),
  cadence: CadenceSchema.partial().optional(),
  policy: PolicySchema.partial().optional(),
  /** Shown in the version list so a rollback has context. */
  note: z.string().max(300).optional(),
});

async function loadRow() {
  const row = await prisma.profile.findUnique({ where: { id: "default" } });
  if (!row) throw new Error("profile not seeded yet — restart the API");
  return row;
}

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/profile", async (_req, reply) => {
    try {
      const row = await loadRow();
      const p = parseProfileRow(row);
      return { ...p, updatedAt: row.updatedAt };
    } catch (e) {
      return reply.code(503).send({ error: (e as Error).message });
    }
  });

  app.patch("/profile", async (req, reply) => {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const body = parsed.data;

    let row;
    try {
      row = await loadRow();
    } catch (e) {
      return reply.code(503).send({ error: (e as Error).message });
    }
    const current = parseProfileRow(row);

    const next = {
      name: body.name ?? current.name,
      identity: { ...current.identity, ...body.identity },
      voice: { ...current.voice, ...body.voice },
      visual: { ...current.visual, ...body.visual },
      cadence: { ...current.cadence, ...body.cadence },
      policy: { ...current.policy, ...body.policy },
    };

    // Validate the MERGED result, not the patch — a partial edit can still
    // produce an invalid whole.
    const check = z
      .object({
        identity: IdentitySchema,
        voice: VoiceSchema,
        visual: VisualSchema,
        cadence: CadenceSchema,
        policy: PolicySchema,
      })
      .safeParse(next);
    if (!check.success) {
      return reply.code(400).send({ error: check.error.flatten() });
    }

    if (!isValidTimeZone(next.cadence.timezone)) {
      return reply.code(400).send({
        error: `unknown timezone "${next.cadence.timezone}" — use an IANA name like Asia/Kolkata`,
      });
    }

    // Safety rail, not a preference. A schedule with no quiet time is a bot
    // pattern, and the human-cadence defence is the main thing standing between
    // this system and an action-block on an irreplaceable account. Preferences
    // are configurable; rails are not.
    const quiet = quietHoursPerDay(next.cadence.quietWindows);
    if (quiet < MIN_QUIET_HOURS_PER_DAY) {
      return reply.code(400).send({
        error:
          `quiet windows total ${quiet}h/day; at least ${MIN_QUIET_HOURS_PER_DAY}h is required. ` +
          `Replying around the clock is a bot pattern and risks the account.`,
      });
    }

    for (const [label, band] of [
      ["morning", next.cadence.morningSession],
      ["evening", next.cadence.eveningSession],
    ] as const) {
      if (band.endMin - band.startMin < 60) {
        return reply.code(400).send({
          error: `${label} session is shorter than an hour; there would be no room to place a sleep window`,
        });
      }
    }

    // A typo'd placeholder would render literally into a live prompt. Cheaper
    // to refuse the write than to find "{{hadnle}}" in a published reply.
    const bad = unknownPlaceholders(next.voice as Voice);
    if (bad.length > 0) {
      return reply.code(400).send({
        error: `unknown placeholder(s): ${bad.map((b) => `{{${b}}}`).join(", ")}`,
      });
    }

    const [, updated] = await prisma.$transaction([
      // Snapshot the OUTGOING state, so version N in the list is what the
      // profile looked like before edit N+1.
      prisma.profileVersion.create({
        data: {
          profileId: row.id,
          version: row.version,
          snapshot: {
            name: current.name,
            identity: current.identity,
            voice: current.voice,
            visual: current.visual,
            cadence: current.cadence,
            policy: current.policy,
          },
          note: body.note ?? null,
        },
      }),
      prisma.profile.update({
        where: { id: row.id },
        data: {
          name: next.name,
          identityJson: next.identity,
          voiceJson: next.voice,
          visualJson: next.visual,
          cadenceJson: next.cadence,
          policyJson: next.policy,
          version: row.version + 1,
        },
      }),
    ]);

    // Write-through so the edit is live immediately in this process; other
    // processes pick it up on their 30s refresh.
    await refreshProfile();
    return { ...parseProfileRow(updated), updatedAt: updated.updatedAt };
  });

  app.get("/profile/versions", async () => {
    const rows = await prisma.profileVersion.findMany({
      where: { profileId: "default" },
      orderBy: { version: "desc" },
      take: 50,
      select: { version: true, note: true, createdAt: true },
    });
    return { versions: rows };
  });

  // Rollback is a forward write, never a rewrite of history: restoring v3
  // creates a new version whose content equals v3.
  app.post<{ Params: { version: string } }>(
    "/profile/rollback/:version",
    async (req, reply) => {
      const target = Number(req.params.version);
      if (!Number.isInteger(target)) {
        return reply.code(400).send({ error: "version must be an integer" });
      }
      const snap = await prisma.profileVersion.findUnique({
        where: { profileId_version: { profileId: "default", version: target } },
      });
      if (!snap) return reply.code(404).send({ error: `no version ${target}` });

      const row = await loadRow();
      const current = parseProfileRow(row);
      const restored = snap.snapshot as Record<string, unknown>;

      const [, updated] = await prisma.$transaction([
        prisma.profileVersion.create({
          data: {
            profileId: row.id,
            version: row.version,
            snapshot: {
              name: current.name,
              identity: current.identity,
              voice: current.voice,
              visual: current.visual,
              cadence: current.cadence,
              policy: current.policy,
            },
            note: `superseded by rollback to v${target}`,
          },
        }),
        prisma.profile.update({
          where: { id: row.id },
          data: {
            name: String(restored.name ?? current.name),
            identityJson: restored.identity as object,
            voiceJson: restored.voice as object,
            visualJson: restored.visual as object,
            cadenceJson: restored.cadence as object,
            policyJson: restored.policy as object,
            version: row.version + 1,
          },
        }),
      ]);

      await refreshProfile();
      return { ...parseProfileRow(updated), rolledBackTo: target };
    }
  );

  // Render a voice block against the CURRENT identity without saving, so an
  // edit can be read as the model will see it. Raw JSON in a textarea is not
  // reviewable; the composed prompt is.
  app.post("/profile/preview", async (req, reply) => {
    const Body = z.object({
      task: z.enum([
        "caption",
        "reply",
        "dashboardStrategist",
        "dashboardCaptionAnalyst",
        "dashboardCommentAnalyst",
      ]),
      voice: z.string().max(20_000).optional(),
      identity: IdentitySchema.partial().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const current = parseProfileRow(await loadRow());
    const draft = {
      ...current,
      identity: { ...current.identity, ...parsed.data.identity },
      voice: {
        ...current.voice,
        ...(parsed.data.voice ? { [parsed.data.task]: parsed.data.voice } : {}),
      },
    };
    const composed = composeSystemPrompt(draft, parsed.data.task);
    return { composed, chars: composed.length };
  });
}
