import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@smm/db";
import {
  builtInOptions,
  refreshStyleOptions,
} from "../services/style-options.js";

// CRUD for the visual taxonomy. `dimension` is a free string throughout — a
// new axis ("prop", "season", "mood") is created by inserting a row with a new
// dimension name, not by shipping a migration.

const KEY = /^[a-z0-9_]+$/;

const CreateBody = z.object({
  dimension: z.string().min(1).max(40).regex(KEY, "dimension must be lowercase a-z0-9_"),
  key: z.string().min(1).max(60).regex(KEY, "key must be lowercase a-z0-9_"),
  label: z.string().min(1).max(80),
  promptText: z.string().min(1).max(4000),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  conflictsWith: z.array(z.string().max(60)).max(40).optional(),
});

const UpdateBody = z.object({
  label: z.string().min(1).max(80).optional(),
  promptText: z.string().min(1).max(4000).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  conflictsWith: z.array(z.string().max(60)).max(40).optional(),
});

export async function registerStyleOptionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/style-options", async () => {
    const rows = await prisma.styleOption.findMany({
      where: { profileId: "default" },
      orderBy: [{ dimension: "asc" }, { sortOrder: "asc" }],
    });
    const byDimension: Record<string, typeof rows> = {};
    for (const r of rows) (byDimension[r.dimension] ??= []).push(r);
    return { dimensions: Object.keys(byDimension).sort(), byDimension };
  });

  app.post("/style-options", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;

    const clash = await prisma.styleOption.findUnique({
      where: {
        profileId_dimension_key: {
          profileId: "default",
          dimension: d.dimension,
          key: d.key,
        },
      },
    });
    if (clash) {
      return reply
        .code(409)
        .send({ error: `${d.dimension}/${d.key} already exists` });
    }

    // Append by default, leaving room to drag between neighbours later.
    const last = await prisma.styleOption.findFirst({
      where: { profileId: "default", dimension: d.dimension },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const created = await prisma.styleOption.create({
      data: {
        profileId: "default",
        dimension: d.dimension,
        key: d.key,
        label: d.label,
        promptText: d.promptText,
        sortOrder: d.sortOrder ?? (last ? last.sortOrder + 10 : 0),
        conflictsWith: d.conflictsWith ?? [],
      },
    });
    await refreshStyleOptions();
    return created;
  });

  app.patch<{ Params: { id: string } }>("/style-options/:id", async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const existing = await prisma.styleOption.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) return reply.code(404).send({ error: "no such option" });

    const updated = await prisma.styleOption.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    await refreshStyleOptions();
    return updated;
  });

  // Soft delete only. A key still referenced by a saved draft must survive, or
  // that draft silently loses an axis; disabling keeps the row resolvable and
  // simply hides it from the picker.
  app.delete<{ Params: { id: string } }>("/style-options/:id", async (req, reply) => {
    const existing = await prisma.styleOption.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) return reply.code(404).send({ error: "no such option" });
    const updated = await prisma.styleOption.update({
      where: { id: req.params.id },
      data: { enabled: false },
    });
    await refreshStyleOptions();
    return updated;
  });

  // Restore the built-in taxonomy for one dimension. Existing keys are left
  // alone — this fills gaps, it does not overwrite edits.
  app.post<{ Params: { dimension: string } }>(
    "/style-options/:dimension/restore-defaults",
    async (req, reply) => {
      const dimension = req.params.dimension;
      const defaults = builtInOptions().filter((o) => o.dimension === dimension);
      if (defaults.length === 0) {
        return reply
          .code(404)
          .send({ error: `no built-in defaults for dimension "${dimension}"` });
      }
      const result = await prisma.styleOption.createMany({
        data: defaults.map((o) => ({ profileId: "default", ...o })),
        skipDuplicates: true,
      });
      await refreshStyleOptions();
      return { restored: result.count, dimension };
    }
  );
}
