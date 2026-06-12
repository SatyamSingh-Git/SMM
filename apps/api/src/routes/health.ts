import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
import { getConfig } from "../services/runtime-config.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    env: env.NODE_ENV,
    killSwitch: getConfig().killSwitch,
    time: new Date().toISOString(),
  }));
}
