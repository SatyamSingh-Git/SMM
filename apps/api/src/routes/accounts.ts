import type { FastifyInstance } from "fastify";
import { prisma } from "@smm/db";
import { listAccounts } from "../services/accounts.js";
import { refreshExpiringTokens } from "../services/token-refresh.js";

// In-memory cooldown so a user mashing "Refresh token" can't spam Meta's
// refresh endpoint (which itself rate-limits and could lock us out).
const REFRESH_COOLDOWN_MS = 5 * 60_000;
let lastManualRefresh = 0;

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get("/accounts", async () => {
    return { accounts: await listAccounts() };
  });

  // Manual token refresh (force). 5-min server cooldown shared across accounts.
  app.post<{ Params: { id: string } }>(
    "/accounts/:id/refresh-token",
    async (req, reply) => {
      const acc = await prisma.account.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!acc) return reply.code(404).send({ error: "not found" });

      const sinceLast = Date.now() - lastManualRefresh;
      if (sinceLast < REFRESH_COOLDOWN_MS) {
        const waitSec = Math.ceil((REFRESH_COOLDOWN_MS - sinceLast) / 1000);
        return reply
          .code(429)
          .send({ error: `cooldown — try again in ${waitSec}s` });
      }
      lastManualRefresh = Date.now();

      // force=true refreshes regardless of remaining expiry. Health columns are
      // written by refreshExpiringTokens; we just report the outcome + fresh rows.
      const result = await refreshExpiringTokens({ force: true });
      const accounts = await listAccounts();
      return { result, accounts };
    }
  );
}
