import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env } from "./env.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerTestRoutes } from "./routes/test.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerPostRoutes } from "./routes/posts.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerInspireRoutes } from "./routes/inspire.js";
import { registerLocationRoutes } from "./routes/locations.js";
import { registerEngagementRoutes } from "./routes/engagement.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { ensureAccountsFromEnv } from "./services/accounts.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  await app.register(cors, { origin: true });

  await registerHealthRoutes(app);
  await registerWebhookRoutes(app);
  await registerTestRoutes(app);
  await registerMediaRoutes(app);
  await registerAccountRoutes(app);
  await registerPostRoutes(app);
  await registerAiRoutes(app);
  await registerInspireRoutes(app);
  await registerLocationRoutes(app);
  await registerEngagementRoutes(app);
  await registerDashboardRoutes(app);

  // Seed/refresh accounts from env tokens on boot. Non-fatal if it fails
  // (e.g. token expired) — the API still serves other endpoints.
  ensureAccountsFromEnv().catch((e) =>
    app.log.error({ err: e }, "ensureAccountsFromEnv failed")
  );

  return app;
}
