import { buildServer } from "./server.js";
import { env } from "./env.js";

async function main() {
  const app = await buildServer();
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  app.log.info(
    { kill_switch: env.KILL_SWITCH },
    `SMM API listening on :${env.API_PORT}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
