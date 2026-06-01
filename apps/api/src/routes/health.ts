import type { FastifyInstance } from "fastify";
import { env } from "../env.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    env: env.NODE_ENV,
    killSwitch: env.KILL_SWITCH,
    time: new Date().toISOString(),
  }));
}
