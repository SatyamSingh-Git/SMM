// Production entry point: runs the HTTP API and the Postgres-polling runners in
// a single Node process. In dev we run them as separate processes (two terminal
// windows is informative); in production on Fly, one machine running everything
// is the simplest deployable shape — and lets us mount one volume for media.

import { buildServer } from "./server.js";
import { env } from "./env.js";
import "./worker.js"; // publish runner (Postgres polling) + token-refresh loop

// Stage 2 engagement runner is conditional — set ENGAGEMENT_ENABLED=false in
// Fly if memory is tight, and run it on your local machine instead.
if (env.ENGAGEMENT_ENABLED) {
  await import("./engagement-worker.js");
}

async function main() {
  const app = await buildServer();
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  app.log.info(
    { kill_switch: env.KILL_SWITCH, port: env.API_PORT },
    "SMM api + worker started"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
