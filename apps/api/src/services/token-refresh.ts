import { prisma } from "@smm/db";
import { decryptToken, encryptToken } from "../crypto.js";

// Long-lived IG and Threads tokens expire 60 days after issue.
// Meta lets us exchange a still-valid long-lived token for a new one any time;
// we do this any time the current token has <7 days left, or expiry is unknown.
//
// Endpoints:
//   IG:      GET https://graph.instagram.com/refresh_access_token
//                ?grant_type=ig_refresh_token&access_token=<token>
//   Threads: GET https://graph.threads.net/refresh_access_token
//                ?grant_type=th_refresh_token&access_token=<token>
// Both return: { access_token, token_type, expires_in } where expires_in is seconds.

const REFRESH_BUFFER_MS = 7 * 24 * 60 * 60 * 1000; // refresh when ≤7d left

type RefreshResult = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

async function refreshOne(platform: "instagram" | "threads", token: string): Promise<RefreshResult> {
  const url =
    platform === "instagram"
      ? `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`
      : `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`refresh ${platform} failed ${res.status}: ${text}`);
  }
  return JSON.parse(text) as RefreshResult;
}

/**
 * Walk all Account rows and refresh tokens that are within REFRESH_BUFFER_MS of expiry
 * (or whose expiry is unknown — happens for accounts we just seeded from env).
 */
export async function refreshExpiringTokens(opts?: { force?: boolean }): Promise<{
  refreshed: number;
  skipped: number;
  failed: Array<{ accountId: string; error: string }>;
}> {
  const accounts = await prisma.account.findMany();
  let refreshed = 0;
  let skipped = 0;
  const failed: Array<{ accountId: string; error: string }> = [];

  const now = Date.now();
  for (const acc of accounts) {
    const exp = acc.tokenExpiresAt ? acc.tokenExpiresAt.getTime() : null;
    const needsRefresh =
      opts?.force === true ||
      exp === null ||
      exp - now < REFRESH_BUFFER_MS;
    if (!needsRefresh) {
      skipped++;
      continue;
    }
    try {
      const oldToken = decryptToken(acc.accessTokenEncrypted);
      const out = await refreshOne(acc.platform, oldToken);
      const newExpiry = new Date(Date.now() + out.expires_in * 1000);
      await prisma.account.update({
        where: { id: acc.id },
        data: {
          accessTokenEncrypted: encryptToken(out.access_token),
          tokenExpiresAt: newExpiry,
        },
      });
      refreshed++;
      console.log(
        `[token-refresh] ✅ ${acc.platform}:${acc.username ?? acc.id} expires ${newExpiry.toISOString()}`
      );
    } catch (e) {
      const msg = (e as Error).message;
      failed.push({ accountId: acc.id, error: msg });
      console.error(`[token-refresh] ❌ ${acc.platform}:${acc.username ?? acc.id}:`, msg);
    }
  }
  return { refreshed, skipped, failed };
}

/**
 * Run on a 6-hour interval inside the worker process. Returns the timer
 * so callers can clearInterval on shutdown.
 */
export function startTokenRefreshLoop(): NodeJS.Timeout {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  // Run once 30 seconds after boot so we don't spam Meta on every restart.
  const initial = setTimeout(() => {
    refreshExpiringTokens().catch((e) =>
      console.error("[token-refresh] initial run error:", (e as Error).message)
    );
  }, 30_000);
  initial.unref();

  const interval = setInterval(() => {
    refreshExpiringTokens().catch((e) =>
      console.error("[token-refresh] periodic run error:", (e as Error).message)
    );
  }, SIX_HOURS);
  interval.unref();
  return interval;
}
