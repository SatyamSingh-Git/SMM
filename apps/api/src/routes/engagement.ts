import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@smm/db";
import { learnThreadsStyle } from "../services/style-learning.js";
import { pollForNewComments } from "../services/engagement.js";
import { generateThreadsReply } from "../services/reply-generator.js";
import {
  todaysReplyCount,
  avoidQuietWindows,
  getDynamicSleepWindowsForDay,
} from "../services/reply-schedule.js";

const ListQuery = z.object({
  status: z
    .enum(["new", "queued", "replying", "replied", "skipped", "failed"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function minutesToHm(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export async function registerEngagementRoutes(app: FastifyInstance): Promise<void> {
  // GET /engagement/comments — list recent comments + status
  app.get("/engagement/comments", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { status, limit } = parsed.data;
    const comments = await prisma.engagementComment.findMany({
      where: { ...(status && { status }) },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    // Bring replied to the top within the window, then everything else by
    // updatedAt desc. So whatever the agent just replied to floats up first.
    comments.sort((a, b) => {
      const aReplied = a.status === "replied" ? 0 : 1;
      const bReplied = b.status === "replied" ? 0 : 1;
      if (aReplied !== bReplied) return aReplied - bReplied;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return { comments };
  });

  // GET /engagement/stats — counts per status (for the dashboard summary card)
  app.get("/engagement/stats", async () => {
    const rows = await prisma.engagementComment.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = r._count._all;
    const [styleCount, repliesToday] = await Promise.all([
      prisma.styleExample.count({ where: { platform: "threads" } }),
      todaysReplyCount(),
    ]);
    return { counts, styleExamples: styleCount, repliesToday };
  });

  // GET /engagement/sleep-windows — show the current quiet windows so the
  // user can verify the runner is using what they expect. Returns both the
  // fixed quiet windows AND today's deterministic dynamic windows.
  app.get("/engagement/sleep-windows", async (req) => {
    const dateParam = (req.query as { date?: string }).date;
    // Convert UTC now → IST date "YYYY-MM-DD"
    const istNow = new Date(Date.now() + (5 * 60 + 30) * 60_000);
    const todayKey = `${istNow.getUTCFullYear()}-${String(
      istNow.getUTCMonth() + 1
    ).padStart(2, "0")}-${String(istNow.getUTCDate()).padStart(2, "0")}`;
    const dateKey =
      dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : todayKey;
    const dynamic = getDynamicSleepWindowsForDay(dateKey).map((w) => ({
      start: minutesToHm(w.startMin),
      end: minutesToHm(w.endMin),
      durationMin: w.endMin - w.startMin,
    }));
    return {
      timezone: "IST (UTC+5:30)",
      dateKey,
      todayIst: todayKey,
      nowIst: `${String(istNow.getUTCHours()).padStart(2, "0")}:${String(
        istNow.getUTCMinutes()
      ).padStart(2, "0")}`,
      fixedQuietWindows: [
        // Overnight window crosses midnight: 23:00 IST today → 06:00 IST tomorrow.
        { start: "23:00", end: "06:00", durationMin: 420, label: "overnight" },
        { start: "11:00", end: "12:00", durationMin: 60, label: "morning break" },
        { start: "14:00", end: "16:00", durationMin: 120, label: "afternoon break" },
      ],
      dynamicSleepWindows: dynamic,
      sessions: {
        morning: { start: "06:00", end: "11:00" },
        evening: { start: "16:00", end: "24:00" },
      },
    };
  });

  // POST /engagement/learn-style — kick off the style-learning import
  app.post("/engagement/learn-style", async (_req, reply) => {
    try {
      const result = await learnThreadsStyle();
      return result;
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // POST /engagement/poll-now — manually trigger a comment poll (for testing)
  app.post("/engagement/poll-now", async (_req, reply) => {
    try {
      const result = await pollForNewComments();
      return result;
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // POST /engagement/comments/:id/cancel — mark a queued comment as skipped.
  // The polling reply runner only fires status="queued"; "skipped" is ignored.
  app.post<{ Params: { id: string } }>(
    "/engagement/comments/:id/cancel",
    async (req, reply) => {
      const c = await prisma.engagementComment.findUnique({
        where: { id: req.params.id },
      });
      if (!c) return reply.code(404).send({ error: "not found" });
      if (c.status === "replied")
        return reply.code(400).send({ error: "already replied" });

      const updated = await prisma.engagementComment.update({
        where: { id: c.id },
        data: { status: "skipped" },
      });
      return updated;
    }
  );

  // POST /engagement/comments/:id/preview — dry-run reply generation.
  // Returns what the agent WOULD say right now without sending it or
  // writing to the DB. Useful for the "preview before send" UI.
  app.post<{ Params: { id: string } }>(
    "/engagement/comments/:id/preview",
    async (req, reply) => {
      const c = await prisma.engagementComment.findUnique({
        where: { id: req.params.id },
      });
      if (!c) return reply.code(404).send({ error: "not found" });
      try {
        const decision = await generateThreadsReply({
          postCaption: c.postCaption,
          authorUsername: c.authorUsername,
          commentText: c.text,
        });
        return decision;
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    }
  );

  // POST /engagement/comments/:id/retry — retry a failed reply
  app.post<{ Params: { id: string } }>(
    "/engagement/comments/:id/retry",
    async (req, reply) => {
      const c = await prisma.engagementComment.findUnique({
        where: { id: req.params.id },
      });
      if (!c) return reply.code(404).send({ error: "not found" });
      if (c.status === "replied")
        return reply.code(400).send({ error: "already replied" });

      // fireAt = now (pushed past any active quiet window) so the runner
      // picks it up on its next tick — but never schedules into a window.
      const fireAtMs = avoidQuietWindows(Date.now());
      await prisma.engagementComment.update({
        where: { id: c.id },
        data: {
          status: "queued",
          lastError: null,
          fireAt: new Date(fireAtMs),
        },
      });
      return { ok: true };
    }
  );
}
