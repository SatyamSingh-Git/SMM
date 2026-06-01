import { prisma } from "@smm/db";
import { env } from "../env.js";
import { encryptToken } from "../crypto.js";
import { getMe as threadsGetMe } from "../publishers/threads.js";
import { getMe as igGetMe } from "../publishers/instagram.js";

// On startup we ensure an Account row exists for each configured token.
// The token itself is encrypted with TOKEN_ENCRYPTION_KEY before storage.
// We re-encrypt on every boot to refresh in case the env token changed.

export async function ensureAccountsFromEnv(): Promise<void> {
  if (env.THREADS_ACCESS_TOKEN) {
    try {
      const me = await threadsGetMe(env.THREADS_ACCESS_TOKEN);
      // We don't know the real expiry of a token pasted from env, but Meta's
      // long-lived tokens are issued for 60 days. Use that as a conservative
      // initial estimate — the refresh loop will replace it with the true
      // value the first time it runs successfully.
      const initialExpiry = new Date(Date.now() + 60 * 24 * 3_600_000);
      await prisma.account.upsert({
        where: {
          platform_platformUserId: {
            platform: "threads",
            platformUserId: me.id,
          },
        },
        create: {
          platform: "threads",
          platformUserId: me.id,
          username: me.username,
          accessTokenEncrypted: encryptToken(env.THREADS_ACCESS_TOKEN),
          tokenExpiresAt: initialExpiry,
        },
        update: {
          username: me.username,
          accessTokenEncrypted: encryptToken(env.THREADS_ACCESS_TOKEN),
          // Don't clobber a real expiry we may have already learned from
          // a successful refresh — only set if currently null.
          ...(await tokenExpiresAtFallback("threads", me.id, initialExpiry)),
        },
      });
    } catch (e) {
      console.error("[accounts] threads seed failed:", (e as Error).message);
    }
  }

  if (env.INSTAGRAM_ACCESS_TOKEN) {
    try {
      const me = await igGetMe(env.INSTAGRAM_ACCESS_TOKEN);
      const initialExpiry = new Date(Date.now() + 60 * 24 * 3_600_000);
      await prisma.account.upsert({
        where: {
          platform_platformUserId: {
            platform: "instagram",
            platformUserId: me.id,
          },
        },
        create: {
          platform: "instagram",
          platformUserId: me.id,
          username: me.username,
          accessTokenEncrypted: encryptToken(env.INSTAGRAM_ACCESS_TOKEN),
          tokenExpiresAt: initialExpiry,
        },
        update: {
          username: me.username,
          accessTokenEncrypted: encryptToken(env.INSTAGRAM_ACCESS_TOKEN),
          ...(await tokenExpiresAtFallback("instagram", me.id, initialExpiry)),
        },
      });
    } catch (e) {
      console.error("[accounts] instagram seed failed:", (e as Error).message);
    }
  }
}

export type AccountInfo = {
  id: string;
  platform: "instagram" | "threads";
  platformUserId: string;
  username: string | null;
};

export async function listAccounts(): Promise<AccountInfo[]> {
  const rows = await prisma.account.findMany({
    select: { id: true, platform: true, platformUserId: true, username: true },
    orderBy: { platform: "asc" },
  });
  return rows;
}

// Only sets tokenExpiresAt on update if the existing row has no expiry yet.
// This way the refresh loop's true expiry isn't overwritten on every boot
// when we reseed from env.
async function tokenExpiresAtFallback(
  platform: "instagram" | "threads",
  platformUserId: string,
  fallback: Date
): Promise<{ tokenExpiresAt?: Date }> {
  const existing = await prisma.account.findUnique({
    where: { platform_platformUserId: { platform, platformUserId } },
    select: { tokenExpiresAt: true },
  });
  if (existing?.tokenExpiresAt) return {};
  return { tokenExpiresAt: fallback };
}

export async function getAccountById(id: string): Promise<{
  id: string;
  platform: "instagram" | "threads";
  platformUserId: string;
  username: string | null;
  accessTokenEncrypted: string;
} | null> {
  return prisma.account.findUnique({ where: { id } });
}
