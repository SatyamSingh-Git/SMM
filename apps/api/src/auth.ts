import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env.js";

function matchesToken(value: string): boolean {
  if (!env.API_AUTH_TOKEN) return false;
  const provided = Buffer.from(value);
  const expected = Buffer.from(env.API_AUTH_TOKEN);
  return (
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}

export async function requireApiAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authorization = request.headers.authorization;
  const token =
    authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";

  if (!matchesToken(token)) {
    await reply
      .code(401)
      .header("WWW-Authenticate", "Bearer")
      .send({ error: "authentication required" });
  }
}
