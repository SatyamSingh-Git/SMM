import type { FastifyInstance } from "fastify";
import { listAccounts } from "../services/accounts.js";

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get("/accounts", async () => {
    return { accounts: await listAccounts() };
  });
}
