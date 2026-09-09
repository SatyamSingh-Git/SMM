import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
import {
  backupConfig,
  newestBackupAt,
  restoreDrill,
  runBackup,
  shouldRunBackup,
} from "../services/db-backup.js";

// Operational endpoints for the backup system. Read-only status plus the two
// manual triggers you want during an incident: take one now, and prove the
// newest one actually restores.

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/backup/status", async () => {
    const configured = backupConfig() !== null && !!env.BACKUP_PASSPHRASE;
    if (!configured) {
      return { enabled: env.BACKUP_ENABLED, configured: false, newestAt: null };
    }
    const newestAt = await newestBackupAt();
    return {
      enabled: env.BACKUP_ENABLED,
      configured: true,
      newestAt: newestAt?.toISOString() ?? null,
      ageHours: newestAt
        ? Math.round(((Date.now() - newestAt.getTime()) / 3_600_000) * 10) / 10
        : null,
      dueNow: shouldRunBackup(newestAt, new Date()),
    };
  });

  app.post("/admin/backup/run", async (_req, reply) => {
    try {
      return await runBackup();
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // The drill creates and drops a scratch database, so it is slow (minutes on
  // a real dump) and deliberately manual.
  app.post("/admin/backup/restore-test", async (_req, reply) => {
    try {
      const result = await restoreDrill();
      return reply.code(result.ok ? 200 : 500).send(result);
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  });
}
