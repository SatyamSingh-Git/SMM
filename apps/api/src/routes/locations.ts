import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@smm/db";
import { decryptToken } from "../crypto.js";

// IG location tags use a Facebook Page ID (locations are modeled as Pages).
// Meta exposes `pages/search?q=...` on graph.facebook.com using the IG long-lived
// access token. We proxy the call so the dashboard never sees the token.
//
// Note: in some apps using "Instagram Login" (not "Facebook Login for Business"),
// Meta restricts pages/search. If we hit that, the response will include an error
// from Meta which we surface to the UI.

const FB_API = "https://graph.facebook.com/v22.0";

const QuerySchema = z.object({
  q: z.string().min(2).max(100),
  accountId: z.string().min(1),
});

type Loc = {
  id: string;
  name: string;
  location?: {
    city?: string;
    country?: string;
    state?: string;
  };
};

export async function registerLocationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/locations/search", async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { q, accountId } = parsed.data;

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account || account.platform !== "instagram") {
      return reply.code(400).send({ error: "instagram account required" });
    }
    const token = decryptToken(account.accessTokenEncrypted);

    const url = new URL(`${FB_API}/pages/search`);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "id,name,location");
    url.searchParams.set("access_token", token);

    try {
      const res = await fetch(url.toString());
      const body = (await res.json()) as
        | { data: Loc[] }
        | { error: { message: string; type: string; code: number } };
      if ("error" in body) {
        return reply.code(502).send({ error: body.error });
      }
      // Filter to results that have an actual lat/long (real places, not Pages)
      // — pages/search returns lots of brand pages too.
      const filtered = body.data.filter((l) => l.location !== undefined);
      return { results: filtered };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
