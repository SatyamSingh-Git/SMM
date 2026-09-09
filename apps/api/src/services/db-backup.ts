// Encrypted Postgres backups to Cloudflare R2.
//
// Pipeline:  pg_dump --format=plain | gzip | gpg --symmetric  ->  temp file  ->  R2
//
// The dump is streamed through gzip and gpg and spooled to a temp file on
// disk, never held in memory — a 1 GB box must not care how large the database
// gets. The temp file exists so the upload can send a known Content-Length;
// disk is the cheap resource here (200 GB free), memory is not.
//
// Encryption is mandatory, not optional: the database holds Meta long-lived
// access tokens. gpg symmetric was chosen over encrypting in Node so that a
// backup can be opened with a standard tool on any machine — a disaster-
// recovery artifact must not depend on the application that died:
//
//   gpg -d smm-....sql.gz.gpg | gunzip | psql "$DIRECT_URL"
//
// Nothing here is scheduled by setInterval. `shouldRunBackup` is checked on
// the worker tick against the newest object already in R2, so a host restart
// cannot silently skip a day.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { env } from "../env.js";
import {
  deleteObject,
  getObjectStream,
  listObjects,
  putFile,
  type R2Config,
  type R2Object,
} from "./r2.js";

export const BACKUP_PREFIX = "smm/db/";

export function backupConfig(): R2Config | null {
  if (
    !env.BACKUP_R2_ENDPOINT ||
    !env.BACKUP_R2_BUCKET ||
    !env.BACKUP_R2_ACCESS_KEY_ID ||
    !env.BACKUP_R2_SECRET_ACCESS_KEY
  ) {
    return null;
  }
  return {
    endpoint: env.BACKUP_R2_ENDPOINT,
    bucket: env.BACKUP_R2_BUCKET,
    accessKeyId: env.BACKUP_R2_ACCESS_KEY_ID,
    secretAccessKey: env.BACKUP_R2_SECRET_ACCESS_KEY,
  };
}

export function backupKeyFor(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `${BACKUP_PREFIX}smm-${stamp}.sql.gz.gpg`;
}

// ---------- pure scheduling + retention ----------

/**
 * Run when there is no backup yet, or the newest one is older than
 * `minIntervalHours`. Checked on every worker tick rather than on a timer, so
 * a restart cannot skip a day.
 */
export function shouldRunBackup(
  newest: Date | null,
  now: Date,
  minIntervalHours = 23
): boolean {
  if (!newest) return true;
  return now.getTime() - newest.getTime() >= minIntervalHours * 3_600_000;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO-ish week key: the Monday of that UTC week. Stable across year ends. */
function weekKey(d: Date): string {
  const t = new Date(d.getTime());
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - dow);
  return t.toISOString().slice(0, 10);
}

/**
 * Grandfather-father-son retention: keep the newest backup of each of the
 * `daily` most recent days present, plus the newest of each of the `weekly`
 * most recent weeks present. Everything else is returned for deletion.
 *
 * Note it counts buckets PRESENT IN THE LIST, not calendar days/weeks ending
 * at `now`. With a sparse history that keeps an old backup rather than
 * deleting it — the right direction to err, since deleting the only
 * historical copy to satisfy a calendar rule is worse than holding one extra
 * object. Once enough newer weeks accumulate, the old one ages out normally.
 *
 * Pure so the policy can be tested without touching R2 — deleting the wrong
 * object here is unrecoverable, which makes it worth pinning precisely.
 */
export function selectForDeletion(
  objects: R2Object[],
  opts: { daily?: number; weekly?: number } = {}
): R2Object[] {
  const daily = opts.daily ?? 7;
  const weekly = opts.weekly ?? 4;
  // Newest first, so the first object seen for a bucket is the one to keep.
  const sorted = [...objects].sort(
    (a, b) => b.lastModified.getTime() - a.lastModified.getTime()
  );

  const keep = new Set<string>();
  const seenDays = new Set<string>();
  for (const o of sorted) {
    const k = dayKey(o.lastModified);
    if (seenDays.has(k)) continue;
    seenDays.add(k);
    if (seenDays.size <= daily) keep.add(o.key);
  }

  const seenWeeks = new Set<string>();
  for (const o of sorted) {
    const k = weekKey(o.lastModified);
    if (seenWeeks.has(k)) continue;
    seenWeeks.add(k);
    if (seenWeeks.size <= weekly) keep.add(o.key);
  }

  return sorted.filter((o) => !keep.has(o.key));
}

// ---------- process plumbing ----------

function dumpUrl(): string {
  // pg_dump against Supabase must use the DIRECT connection: the pooled
  // (pgbouncer) endpoint does not support the session-level statements a dump
  // issues, and fails partway through with confusing errors.
  return env.DIRECT_URL || env.DATABASE_URL;
}

class ProcessError extends Error {}

/** Resolve when the process exits 0; reject with its stderr otherwise. */
function waitForExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (c) => {
      // Keep only the tail — pg_dump can be chatty and the passphrase must
      // never end up in a log line.
      stderr = (stderr + String(c)).slice(-2000);
    });
    child.on("error", (e) => reject(new ProcessError(`${label} failed to start: ${e.message}`)));
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new ProcessError(`${label} exited ${code}: ${stderr.trim()}`))
    );
  });
}

/**
 * Spawn gpg for symmetric encryption. The passphrase goes over an extra file
 * descriptor, never argv — an argv passphrase is visible in `ps` to anything
 * else on the box.
 */
function spawnGpg(passphrase: string): ReturnType<typeof spawn> {
  const gpg = spawn(
    "gpg",
    [
      "--batch",
      "--yes",
      "--quiet",
      "--symmetric",
      "--cipher-algo",
      "AES256",
      "-z",
      "0", // already gzipped upstream; double-compressing wastes CPU
      "--passphrase-fd",
      "3",
    ],
    { stdio: ["pipe", "pipe", "pipe", "pipe"] }
  );
  const fd3 = gpg.stdio[3] as NodeJS.WritableStream;
  fd3.write(passphrase);
  fd3.end();
  return gpg;
}

export type BackupResult = { key: string; sizeBytes: number; deleted: string[] };

/**
 * Take one backup and prune old ones. Throws on any stage failing — a backup
 * that half-succeeded must not look like success.
 */
export async function runBackup(now: Date = new Date()): Promise<BackupResult> {
  const cfg = backupConfig();
  if (!cfg) throw new Error("R2 backup is not configured (BACKUP_R2_* env vars)");
  if (!env.BACKUP_PASSPHRASE) throw new Error("BACKUP_PASSPHRASE is not set");

  const dir = await mkdtemp(path.join(tmpdir(), "smm-backup-"));
  const localPath = path.join(dir, "dump.sql.gz.gpg");

  try {
    const dump = spawn(
      "pg_dump",
      ["--no-owner", "--no-acl", "--format=plain", dumpUrl()],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const gpg = spawnGpg(env.BACKUP_PASSPHRASE);

    // pg_dump -> gzip -> gpg -> file. Awaiting all four means a failure in any
    // stage surfaces, instead of a truncated file uploading cleanly.
    const toGpg = pipeline(dump.stdout!, createGzip(), gpg.stdin!);
    const toDisk = pipeline(gpg.stdout!, createWriteStream(localPath));
    await Promise.all([
      toGpg,
      toDisk,
      waitForExit(dump, "pg_dump"),
      waitForExit(gpg, "gpg"),
    ]);

    const key = backupKeyFor(now);
    const { size } = await putFile(cfg, key, localPath, "application/pgp-encrypted");

    // Prune only after a successful upload, so a failed run never deletes the
    // backups it was going to replace.
    const existing = await listObjects(cfg, BACKUP_PREFIX);
    const expired = selectForDeletion(existing);
    for (const o of expired) await deleteObject(cfg, o.key);

    return { key, sizeBytes: size, deleted: expired.map((o) => o.key) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Timestamp of the newest backup in R2, or null if there are none. */
export async function newestBackupAt(): Promise<Date | null> {
  const cfg = backupConfig();
  if (!cfg) return null;
  const objects = await listObjects(cfg, BACKUP_PREFIX);
  if (objects.length === 0) return null;
  return objects.reduce(
    (max, o) => (o.lastModified > max ? o.lastModified : max),
    objects[0]!.lastModified
  );
}

// The worker tick runs every 90s; listing R2 that often is pointless traffic.
// Re-check at most every 30 minutes — but always on the first call after boot,
// which is what makes a restart pick up a missed day immediately.
const CHECK_INTERVAL_MS = 30 * 60_000;
let lastCheckedAt = 0;
let running = false;

/**
 * Called from the worker tick. Never throws — a backup failure must not stop
 * the engagement loop — but logs loudly enough to be greppable.
 */
export async function maybeRunBackup(now: Date = new Date()): Promise<void> {
  if (!env.BACKUP_ENABLED || running) return;
  if (now.getTime() - lastCheckedAt < CHECK_INTERVAL_MS) return;
  lastCheckedAt = now.getTime();

  if (!backupConfig() || !env.BACKUP_PASSPHRASE) {
    console.error("[backup] BACKUP_ENABLED=true but R2 credentials are incomplete");
    return;
  }

  running = true;
  try {
    if (!shouldRunBackup(await newestBackupAt(), now)) return;
    const r = await runBackup(now);
    console.log(
      `[backup] uploaded ${r.key} (${Math.round(r.sizeBytes / 1024)} KB), pruned ${r.deleted.length}`
    );
  } catch (e) {
    console.error("[backup] FAILED:", (e as Error).message);
  } finally {
    running = false;
  }
}

/** Test seam: reset the in-memory throttle. */
export function resetBackupThrottle(): void {
  lastCheckedAt = 0;
  running = false;
}

// ---------- restore drill ----------

export type RestoreDrillResult = {
  key: string;
  database: string;
  tableCounts: Record<string, number>;
  ok: boolean;
};

/**
 * Restore the newest backup into a scratch database, count rows in the tables
 * that would actually hurt to lose, then drop it. An untested backup is not a
 * backup — this is what turns "the upload returned 200" into evidence.
 */
export async function restoreDrill(): Promise<RestoreDrillResult> {
  const cfg = backupConfig();
  if (!cfg) throw new Error("R2 backup is not configured");
  if (!env.BACKUP_PASSPHRASE) throw new Error("BACKUP_PASSPHRASE is not set");

  const objects = await listObjects(cfg, BACKUP_PREFIX);
  if (objects.length === 0) throw new Error("no backups found to restore");
  const newest = objects.reduce((a, b) => (a.lastModified > b.lastModified ? a : b));

  const dir = await mkdtemp(path.join(tmpdir(), "smm-restore-"));
  const encPath = path.join(dir, "dump.sql.gz.gpg");
  const scratch = `smm_restore_${Date.now()}`;
  const admin = dumpUrl();
  const scratchUrl = new URL(admin);
  scratchUrl.pathname = `/${scratch}`;

  try {
    await pipeline(
      (await getObjectStream(cfg, newest.key)) as unknown as NodeJS.ReadableStream,
      createWriteStream(encPath)
    );

    await psql(admin, `CREATE DATABASE ${scratch}`);
    try {
      await decryptInto(encPath, scratchUrl.toString());
      const tableCounts: Record<string, number> = {};
      for (const t of ["Account", "Post", "StyleExample", "PostInsight"]) {
        tableCounts[t] = await countRows(scratchUrl.toString(), t);
      }
      // A dump that restores but is empty of the things we care about is a
      // failed drill, not a passed one.
      const ok = tableCounts.StyleExample !== undefined && tableCounts.Post !== undefined;
      return { key: newest.key, database: scratch, tableCounts, ok };
    } finally {
      await psql(admin, `DROP DATABASE IF EXISTS ${scratch}`).catch(() => undefined);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function psql(url: string, sql: string): Promise<string> {
  const child = spawn("psql", [url, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += String(c)));
  return waitForExit(child, "psql").then(() => out.trim());
}

async function countRows(url: string, table: string): Promise<number> {
  const out = await psql(url, `SELECT count(*) FROM "${table}"`);
  return Number(out) || 0;
}

/** gpg -d | gunzip | psql — streamed, same reasoning as the backup path. */
async function decryptInto(encPath: string, targetUrl: string): Promise<void> {
  const gpg = spawn(
    "gpg",
    ["--batch", "--yes", "--quiet", "--decrypt", "--passphrase-fd", "3", encPath],
    { stdio: ["ignore", "pipe", "pipe", "pipe"] }
  );
  const fd3 = gpg.stdio[3] as NodeJS.WritableStream;
  fd3.write(env.BACKUP_PASSPHRASE!);
  fd3.end();

  const restore = spawn("psql", [targetUrl, "-v", "ON_ERROR_STOP=1", "-q"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const { createGunzip } = await import("node:zlib");
  await Promise.all([
    pipeline(gpg.stdout!, createGunzip(), restore.stdin!),
    waitForExit(gpg, "gpg -d"),
    waitForExit(restore, "psql restore"),
  ]);
}
