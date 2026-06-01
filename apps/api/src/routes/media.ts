import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { prisma } from "@smm/db";
import { UPLOAD_DIR, saveBuffer } from "../storage.js";

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  // Serve uploaded files publicly. The Cloudflare Tunnel exposes this path
  // to Meta so it can fetch images during the container creation step.
  await app.register(staticPlugin, {
    root: UPLOAD_DIR,
    prefix: "/media/",
    decorateReply: false,
  });

  await app.register(multipart, {
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB cap
  });

  // POST /media — upload a single file. Returns { id, publicUrl }.
  app.post("/media", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "no file" });

    const allowed = ["image/jpeg", "image/png", "video/mp4"];
    if (!allowed.includes(file.mimetype)) {
      return reply.code(415).send({
        error: `unsupported mime: ${file.mimetype}. Allowed: ${allowed.join(", ")}`,
      });
    }
    // Meta's IG Content Publishing API accepts JPEG only for image_url; PNG is rejected.
    // We still allow PNG uploads (Threads-friendly), but warn the caller in the response.
    const warnings: string[] = [];
    if (file.mimetype === "image/png") {
      warnings.push(
        "PNG uploaded — Instagram only accepts JPEG. This file will work for Threads, but Instagram publishes will fail unless you re-upload a JPEG."
      );
    }

    const buf = await file.toBuffer();
    const saved = await saveBuffer(buf, file.mimetype);

    // Caller must pass ?accountId=... so the asset is owned by an account.
    const accountId = (req.query as { accountId?: string }).accountId;
    if (!accountId) return reply.code(400).send({ error: "accountId required" });

    const asset = await prisma.mediaAsset.create({
      data: {
        accountId,
        type: file.mimetype.startsWith("video/") ? "video" : "image",
        storageKey: saved.storageKey,
        publicUrl: saved.publicUrl,
        mimeType: file.mimetype,
        sizeBytes: saved.sizeBytes,
      },
    });

    return {
      id: asset.id,
      publicUrl: asset.publicUrl,
      mimeType: asset.mimeType,
      warnings,
    };
  });
}
