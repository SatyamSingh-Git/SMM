import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Local-disk media driver. Uploads land at UPLOAD_DIR and are served at
// /media/* via @fastify/static. The "public URL" we hand back to Meta must
// be reachable via HTTPS — so PUBLIC_BASE_URL is your Cloudflare Tunnel URL
// in dev, or the Fly app URL in production.

export const UPLOAD_DIR =
  env.UPLOAD_DIR ?? path.resolve(__dirname, "..", "uploads");

export async function ensureUploadDir(): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

export type SavedMedia = {
  storageKey: string;
  publicUrl: string;
  sizeBytes: number;
};

export async function saveBuffer(
  buf: Buffer,
  mimeType: string
): Promise<SavedMedia> {
  await ensureUploadDir();
  const ext = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/png" ? ".png" : mimeType === "video/mp4" ? ".mp4" : "";
  const storageKey = `${randomUUID()}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, storageKey);
  await writeFile(fullPath, buf);
  return {
    storageKey,
    publicUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/media/${storageKey}`,
    sizeBytes: buf.length,
  };
}
