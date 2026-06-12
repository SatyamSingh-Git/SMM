import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@smm/db";
import { encryptToken } from "../crypto.js";
import { getConfig, refreshConfig } from "../services/runtime-config.js";

// Fixed session bands (minutes) — must match runtime-config.ts. Used only to
// validate that a sleep config actually fits inside its session.
const MORNING_LEN = (11 - 6) * 60; // 300
const EVENING_LEN = (24 - 16) * 60; // 480
const MIN_ACTIVE = 20; // min active minutes between sleeps + at edges

async function getRow() {
  return prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
}

function view(row: Awaited<ReturnType<typeof getRow>>) {
  const cfg = getConfig();
  return {
    dailyReplyCap: row.dailyReplyCap,
    perPostReplyCap: row.perPostReplyCap,
    morningSleepCount: row.morningSleepCount,
    morningSleepMin: row.morningSleepMin,
    eveningSleepCount: row.eveningSleepCount,
    eveningSleepMin: row.eveningSleepMin,
    // Fixed session bands, surfaced read-only for the UI copy.
    morningBand: "06:00–11:00 IST",
    eveningBand: "16:00–24:00 IST",
    deepseekModel: row.deepseekModel ?? "",
    deepseekModelEffective: cfg.deepseekModel,
    visionModel: row.visionModel ?? "",
    visionModelEffective: cfg.visionModel,
    deepseekApiKeyConfigured: !!cfg.deepseekApiKey,
    deepseekApiKeyLast4: cfg.deepseekApiKey ? cfg.deepseekApiKey.slice(-4) : null,
    openrouterApiKeyConfigured: !!cfg.openrouterApiKey,
    openrouterApiKeyLast4: cfg.openrouterApiKey
      ? cfg.openrouterApiKey.slice(-4)
      : null,
    killSwitch: row.killSwitch,
    autoReplyEnabled: row.autoReplyEnabled,
  };
}

// Does `count` sleeps of `min` minutes fit in a session of `len` minutes, with
// MIN_ACTIVE active time before/between/after each? (count+1 active segments.)
function fits(count: number, min: number, len: number): boolean {
  if (count <= 0) return true;
  return count * min + (count + 1) * MIN_ACTIVE <= len;
}

const Body = z.object({
  dailyReplyCap: z.number().int().min(1).max(2000).optional(),
  perPostReplyCap: z.number().int().min(1).max(1000).optional(),
  morningSleepCount: z.number().int().min(0).max(10).optional(),
  morningSleepMin: z.number().int().min(0).max(240).optional(),
  eveningSleepCount: z.number().int().min(0).max(10).optional(),
  eveningSleepMin: z.number().int().min(0).max(240).optional(),
  deepseekModel: z.string().max(120).optional(),
  visionModel: z.string().max(120).optional(),
  // New plaintext key to store; "" clears the override (fall back to env);
  // omitted leaves the stored key unchanged.
  deepseekApiKey: z.string().max(400).optional(),
  openrouterApiKey: z.string().max(400).optional(),
  killSwitch: z.boolean().optional(),
  autoReplyEnabled: z.boolean().optional(),
});

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings", async () => {
    return view(await getRow());
  });

  app.patch("/settings", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const p = parsed.data;
    const row = await getRow();

    // Validate sleep feasibility against the resulting (merged) values.
    const mCount = p.morningSleepCount ?? row.morningSleepCount;
    const mMin = p.morningSleepMin ?? row.morningSleepMin;
    const eCount = p.eveningSleepCount ?? row.eveningSleepCount;
    const eMin = p.eveningSleepMin ?? row.eveningSleepMin;
    if (!fits(mCount, mMin, MORNING_LEN)) {
      return reply.code(400).send({
        error: `Morning sleeps don't fit: ${mCount}×${mMin}min needs more than the 5h session (leave ≥${MIN_ACTIVE}min active between each). Reduce count or duration.`,
      });
    }
    if (!fits(eCount, eMin, EVENING_LEN)) {
      return reply.code(400).send({
        error: `Evening sleeps don't fit: ${eCount}×${eMin}min needs more than the 8h session (leave ≥${MIN_ACTIVE}min active between each). Reduce count or duration.`,
      });
    }

    const data: Record<string, unknown> = {};
    if (p.dailyReplyCap !== undefined) data.dailyReplyCap = p.dailyReplyCap;
    if (p.perPostReplyCap !== undefined) data.perPostReplyCap = p.perPostReplyCap;
    if (p.morningSleepCount !== undefined) data.morningSleepCount = p.morningSleepCount;
    if (p.morningSleepMin !== undefined) data.morningSleepMin = p.morningSleepMin;
    if (p.eveningSleepCount !== undefined) data.eveningSleepCount = p.eveningSleepCount;
    if (p.eveningSleepMin !== undefined) data.eveningSleepMin = p.eveningSleepMin;
    if (p.deepseekModel !== undefined)
      data.deepseekModel = p.deepseekModel.trim() || null;
    if (p.visionModel !== undefined)
      data.visionModel = p.visionModel.trim() || null;
    if (p.deepseekApiKey !== undefined)
      data.deepseekApiKeyEnc = p.deepseekApiKey.trim()
        ? encryptToken(p.deepseekApiKey.trim())
        : null;
    if (p.openrouterApiKey !== undefined)
      data.openrouterApiKeyEnc = p.openrouterApiKey.trim()
        ? encryptToken(p.openrouterApiKey.trim())
        : null;
    if (p.killSwitch !== undefined) data.killSwitch = p.killSwitch;
    if (p.autoReplyEnabled !== undefined) data.autoReplyEnabled = p.autoReplyEnabled;

    await prisma.appSettings.update({ where: { id: "singleton" }, data });
    // Write-through so the change is live in this process immediately.
    await refreshConfig();
    return view(await getRow());
  });
}
