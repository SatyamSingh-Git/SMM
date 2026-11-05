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
import { registerImagePromptRoutes } from "./routes/image-prompts.js";
import { registerLocationRoutes } from "./routes/locations.js";
import { registerEngagementRoutes } from "./routes/engagement.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerStyleOptionRoutes } from "./routes/style-options.js";
import { ensureAccountsFromEnv } from "./services/accounts.js";
import { startRuntimeConfig } from "./services/runtime-config.js";
import { startProfile } from "./services/profile/resolver.js";
import { startStyleOptions } from "./services/style-options.js";
import { requireApiAuth } from "./auth.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS,
  });

  await registerHealthRoutes(app);
  await registerWebhookRoutes(app);
  if (env.NODE_ENV !== "production") {
    await registerTestRoutes(app);
  }
  await registerMediaRoutes(app);
  await registerAccountRoutes(app);
  await registerPostRoutes(app);
  await registerAiRoutes(app);
  await registerInspireRoutes(app);
  await registerImagePromptRoutes(app);
  await registerLocationRoutes(app);
  await registerEngagementRoutes(app);
  await registerDashboardRoutes(app);
  await registerSettingsRoutes(app);
  await registerAdminRoutes(app);
  await registerProfileRoutes(app);
  await registerStyleOptionRoutes(app);

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "";
    if (path === "/health" || path.startsWith("/webhooks/meta")) return;
    await requireApiAuth(request, reply);
  });

  // Prime the runtime-config cache (idempotent; also self-primes on import).
  startRuntimeConfig();
  // Seed the default profile if missing, then prime its cache. Unlike
  // runtime-config this fails closed — see services/profile/resolver.ts.
  startProfile();
  // Seed the visual taxonomy from the built-in constants if the table is
  // empty, then keep it cached. Falls back to those constants until it loads.
  startStyleOptions();

  // Seed/refresh accounts from env tokens on boot. Non-fatal if it fails
  // (e.g. token expired) — the API still serves other endpoints.
  ensureAccountsFromEnv().catch((e) =>
    app.log.error({ err: e }, "ensureAccountsFromEnv failed")
  );

  return app;
}
