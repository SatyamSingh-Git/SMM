import type { FastifyInstance } from "fastify";
import { env } from "../env.js";

// Stage 1 stub: GET handshake works so Meta can verify the URL exists.
// POST events just ack — full signature verification + queueing is Stage 2.

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.get("/webhooks/meta", async (req, reply) => {
    const q = req.query as {
      "hub.mode"?: string;
      "hub.verify_token"?: string;
      "hub.challenge"?: string;
    };
    if (!env.META_WEBHOOK_VERIFY_TOKEN) {
      return reply.code(503).send({ error: "META_WEBHOOK_VERIFY_TOKEN not set" });
    }
    if (
      q["hub.mode"] === "subscribe" &&
      q["hub.verify_token"] === env.META_WEBHOOK_VERIFY_TOKEN &&
      typeof q["hub.challenge"] === "string"
    ) {
      return reply.code(200).send(q["hub.challenge"]);
    }
    return reply.code(403).send({ error: "verification failed" });
  });

  app.post("/webhooks/meta", async (req, reply) => {
    // TODO Stage 2: verify X-Hub-Signature-256 against META_APP_SECRET on raw body,
    // then push the payload onto an engagement queue.
    req.log.info({ body: req.body }, "meta webhook event received (Stage 2 not wired)");
    return reply.code(200).send({ ok: true });
  });
}
