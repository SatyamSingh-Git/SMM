import { prisma, type Platform } from "@smm/db";

// Aggregates raw rows into the numbers the dashboard cards display.
// "Latest insight" for a post = the row with the largest capturedAt timestamp
// (snapshot velocity declines after ~7d so the latest is effectively final).

const ONE_DAY = 24 * 60 * 60 * 1000;

export type PostWithLatest = {
  id: string;
  platform: Platform;
  type: string;
  caption: string | null;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  platformUrl: string | null;
  // Top media thumbnail for the UI grid (first image asset's publicUrl).
  thumbnailUrl: string | null;
  // Composite engagement number (likes + comments + saves + shares*2). Used
  // for ranking. Higher = better.
  engagement: number;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
};

export async function getRecentPostsWithLatestInsight(opts: {
  days: number;
  limit?: number;
  platform?: Platform;
}): Promise<PostWithLatest[]> {
  const since = new Date(Date.now() - opts.days * ONE_DAY);
  const posts = await prisma.post.findMany({
    where: {
      status: "published",
      updatedAt: { gte: since },
      ...(opts.platform ? { platform: opts.platform } : {}),
    },
    include: {
      insights: { orderBy: { capturedAt: "desc" }, take: 1 },
      assets: {
        orderBy: { position: "asc" },
        take: 1,
        include: { asset: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: opts.limit ?? 200,
  });

  return posts.map((p) => {
    const ins = p.insights[0] ?? null;
    const engagement =
      (ins?.likes ?? 0) +
      (ins?.comments ?? 0) +
      (ins?.saves ?? 0) +
      (ins?.shares ?? 0) * 2 +
      (ins?.reposts ?? 0) * 2 +
      (ins?.quotes ?? 0);
    return {
      id: p.id,
      platform: p.platform,
      type: p.type,
      caption: p.caption,
      scheduledAt: p.scheduledAt,
      // Prefer the real publish column; fall back to updatedAt for rows that
      // predate the column / backfill.
      publishedAt: p.publishedAt ?? p.updatedAt,
      platformUrl: p.platformUrl,
      thumbnailUrl: p.assets[0]?.asset.publicUrl ?? null,
      engagement,
      reach: ins?.reach ?? null,
      views: ins?.views ?? null,
      likes: ins?.likes ?? null,
      comments: ins?.comments ?? null,
      saves: ins?.saves ?? null,
      shares: ins?.shares ?? null,
    };
  });
}

export type KpiBundle = {
  followers: {
    current: number;
    // null = we don't have enough historical snapshots yet (need at least
    // one snapshot from ≥7 days ago to claim a delta honestly).
    delta14d: number | null;
    // How many days of follower history we actually have. UI surfaces this
    // as "tracking started X days ago" so the user knows why delta is null.
    historyDays: number;
  };
  reach7d: number;
  engagementRate: number | null; // percent
  // Reach-normalized share + save rates over the last 7d. Shares are the single
  // strongest reach signal on IG/Threads in 2026 (Mosseri); saves are IG-only.
  // Null when there isn't enough reach to compute an honest rate.
  shareRate7d: number | null; // percent of reach that shared
  saveRate7d: number | null; // percent of reach that saved (IG only)
  postsPublished7d: number;
  repliesHandled: {
    total: number;
    replied: number;
    skipped: number;
    failed: number;
  };
};

export async function getKpis(opts?: { platform?: Platform }): Promise<KpiBundle> {
  const platformFilter = opts?.platform ? { platform: opts.platform } : {};

  // Followers: most-recent snapshot across the requested account(s).
  // Delta14d is honest about its source: we only return a non-null number if
  // we actually have a snapshot from ≥7 days ago (using 14d window but
  // accepting ≥7d so a fresh account gets a useful number after one week).
  const accounts = await prisma.account.findMany({
    where: platformFilter,
    include: { snapshots: { orderBy: { capturedAt: "desc" }, take: 60 } },
  });
  const HISTORY_DELTA_MIN_DAYS = 7;
  const cutoff14 = Date.now() - 14 * ONE_DAY;
  const minOldThreshold = Date.now() - HISTORY_DELTA_MIN_DAYS * ONE_DAY;

  let followersNow = 0;
  let followersThen = 0;
  let haveHistoricalAnchor = true; // false if any account is too fresh
  let oldestSnapMs: number | null = null;

  for (const a of accounts) {
    const latest = a.snapshots[0];
    if (latest) followersNow += latest.followers;

    // Look for a snapshot at-or-before the 14d cutoff; if not, accept any
    // snapshot older than HISTORY_DELTA_MIN_DAYS as a usable anchor.
    const anchor =
      a.snapshots.find((s) => new Date(s.capturedAt).getTime() <= cutoff14) ??
      a.snapshots.find((s) => new Date(s.capturedAt).getTime() <= minOldThreshold);

    if (anchor) {
      followersThen += anchor.followers;
    } else {
      haveHistoricalAnchor = false;
    }

    // Track the oldest snapshot across all accounts for the "tracking started"
    // message in the UI.
    const acctOldest = a.snapshots.at(-1);
    if (acctOldest) {
      const t = new Date(acctOldest.capturedAt).getTime();
      if (oldestSnapMs === null || t < oldestSnapMs) oldestSnapMs = t;
    }
  }

  const historyDays =
    oldestSnapMs !== null
      ? Math.max(0, Math.floor((Date.now() - oldestSnapMs) / ONE_DAY))
      : 0;
  const delta14d = haveHistoricalAnchor && accounts.length > 0
    ? followersNow - followersThen
    : null;

  // Reach + engagement for posts published in the last 7 days.
  const since7 = new Date(Date.now() - 7 * ONE_DAY);
  const recent = await prisma.post.findMany({
    where: { status: "published", updatedAt: { gte: since7 }, ...platformFilter },
    include: { insights: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });
  let reach7d = 0;
  let totalEngagement = 0;
  let totalReachForRate = 0;
  let totalShares = 0;
  let totalSaves = 0;
  for (const p of recent) {
    const ins = p.insights[0];
    if (!ins) continue;
    const r = ins.reach ?? ins.impressions ?? ins.views ?? 0;
    reach7d += r;
    totalReachForRate += r;
    totalShares += ins.shares ?? 0;
    totalSaves += ins.saves ?? 0;
    totalEngagement +=
      (ins.likes ?? 0) +
      (ins.comments ?? 0) +
      (ins.saves ?? 0) +
      (ins.shares ?? 0);
  }
  const engagementRate =
    totalReachForRate > 0 ? (totalEngagement / totalReachForRate) * 100 : null;
  // Need a meaningful reach denominator before quoting a rate — below this the
  // percentage is noise. 2000 reach over 7d is a low bar the active account
  // clears easily, but protects a brand-new/quiet account from junk numbers.
  const MIN_REACH_FOR_RATE = 2000;
  const shareRate7d =
    totalReachForRate >= MIN_REACH_FOR_RATE
      ? (totalShares / totalReachForRate) * 100
      : null;
  const saveRate7d =
    totalReachForRate >= MIN_REACH_FOR_RATE
      ? (totalSaves / totalReachForRate) * 100
      : null;

  // Engagement comments — replies handled over last 7d (filtered to the platform
  // we're scoping to, if any).
  const replyAgg = await prisma.engagementComment.groupBy({
    by: ["status"],
    where: { receivedAt: { gte: since7 }, ...platformFilter },
    _count: { _all: true },
  });
  const r = { total: 0, replied: 0, skipped: 0, failed: 0 };
  for (const row of replyAgg) {
    r.total += row._count._all;
    if (row.status === "replied") r.replied = row._count._all;
    if (row.status === "skipped") r.skipped = row._count._all;
    if (row.status === "failed") r.failed = row._count._all;
  }

  return {
    followers: { current: followersNow, delta14d, historyDays },
    reach7d,
    engagementRate,
    shareRate7d,
    saveRate7d,
    postsPublished7d: recent.length,
    repliesHandled: r,
  };
}

// "Best time to post" recommendation. Unlike the raw 7x24 heatmap (which shows
// averages per cell), this ranks the top slots by average engagement AND
// requires a minimum sample count per slot so we don't recommend a one-off
// fluke. At ~29 posts/week the account accumulates real per-slot samples fast,
// which is exactly why this is worth surfacing (it would be noise at low volume).
export type BestSlot = {
  dayOfWeek: number; // 0 = Monday (matches heatmap / FullCalendar)
  hourIst: number; // 0-23, IST
  avgEngagement: number;
  samples: number; // how many posts landed in this slot
};

export async function getBestPostingSlots(opts?: {
  days?: number;
  platform?: Platform;
  minSamples?: number;
  topN?: number;
}): Promise<{ slots: BestSlot[]; minSamples: number; totalPosts: number }> {
  const days = opts?.days ?? 90;
  const minSamples = opts?.minSamples ?? 3;
  const topN = opts?.topN ?? 5;
  const since = new Date(Date.now() - days * ONE_DAY);
  const posts = await prisma.post.findMany({
    where: {
      status: "published",
      updatedAt: { gte: since },
      ...(opts?.platform ? { platform: opts.platform } : {}),
    },
    include: { insights: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });

  const sumEng: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0)
  );
  const counts: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0)
  );
  let totalPosts = 0;
  for (const p of posts) {
    if (!p.scheduledAt) continue;
    const ins = p.insights[0];
    if (!ins) continue;
    const eng =
      (ins.likes ?? 0) + (ins.comments ?? 0) + (ins.saves ?? 0) + (ins.shares ?? 0);
    const ist = new Date(new Date(p.scheduledAt).getTime() + (5 * 60 + 30) * 60_000);
    const dow = (ist.getUTCDay() + 6) % 7;
    const hour = ist.getUTCHours();
    sumEng[dow]![hour]! += eng;
    counts[dow]![hour]! += 1;
    totalPosts += 1;
  }

  const slots: BestSlot[] = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const n = counts[d]![h]!;
      if (n < minSamples) continue;
      slots.push({
        dayOfWeek: d,
        hourIst: h,
        avgEngagement: Math.round(sumEng[d]![h]! / n),
        samples: n,
      });
    }
  }
  slots.sort((a, b) => b.avgEngagement - a.avgEngagement);
  return { slots: slots.slice(0, topN), minSamples, totalPosts };
}

// 7x24 grid of average engagement by (day-of-week, hour-of-day). Used for the
// "best time to post" heatmap. day index 0 = Monday (matching FullCalendar).
export type PostingHeatmap = number[][]; // [day][hour]

export async function getPostingHeatmap(
  days = 60,
  platform?: Platform
): Promise<PostingHeatmap> {
  const since = new Date(Date.now() - days * ONE_DAY);
  const posts = await prisma.post.findMany({
    where: {
      status: "published",
      updatedAt: { gte: since },
      ...(platform ? { platform } : {}),
    },
    include: { insights: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });
  const sumEng: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0)
  );
  const counts: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0)
  );
  for (const p of posts) {
    if (!p.scheduledAt) continue;
    const ins = p.insights[0];
    if (!ins) continue;
    const eng =
      (ins.likes ?? 0) + (ins.comments ?? 0) + (ins.saves ?? 0) + (ins.shares ?? 0);
    // Convert UTC to IST (UTC+5:30)
    const ist = new Date(new Date(p.scheduledAt).getTime() + (5 * 60 + 30) * 60_000);
    const dow = (ist.getUTCDay() + 6) % 7; // shift so Mon=0
    const hour = ist.getUTCHours();
    sumEng[dow]![hour]! += eng;
    counts[dow]![hour]! += 1;
  }
  return sumEng.map((row, d) =>
    row.map((v, h) => (counts[d]![h]! > 0 ? Math.round(v / counts[d]![h]!) : 0))
  );
}

// Engagement breakdown by post type — answers "should I do more reels or carousels?"
export type TypeBreakdown = Array<{
  type: string;
  count: number;
  avgEngagement: number;
  avgReach: number | null;
}>;

export async function getTypeBreakdown(
  days = 30,
  platform?: Platform
): Promise<TypeBreakdown> {
  const since = new Date(Date.now() - days * ONE_DAY);
  const posts = await prisma.post.findMany({
    where: {
      status: "published",
      updatedAt: { gte: since },
      ...(platform ? { platform } : {}),
    },
    include: { insights: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });
  const map = new Map<string, { count: number; eng: number; reach: number; reachN: number }>();
  for (const p of posts) {
    const ins = p.insights[0];
    const eng = ins
      ? (ins.likes ?? 0) + (ins.comments ?? 0) + (ins.saves ?? 0) + (ins.shares ?? 0)
      : 0;
    const reach = ins?.reach ?? ins?.impressions ?? ins?.views ?? null;
    const cur = map.get(p.type) ?? { count: 0, eng: 0, reach: 0, reachN: 0 };
    cur.count += 1;
    cur.eng += eng;
    if (reach != null) {
      cur.reach += reach;
      cur.reachN += 1;
    }
    map.set(p.type, cur);
  }
  return Array.from(map.entries())
    .map(([type, v]) => ({
      type,
      count: v.count,
      avgEngagement: v.count > 0 ? Math.round(v.eng / v.count) : 0,
      avgReach: v.reachN > 0 ? Math.round(v.reach / v.reachN) : null,
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);
}

// Day-by-day follower count for the growth line chart.
export type FollowerTrend = Array<{ date: string; followers: number }>;

export async function getFollowerTrend(
  days = 60,
  platform?: Platform
): Promise<FollowerTrend> {
  const since = new Date(Date.now() - days * ONE_DAY);
  const snaps = await prisma.accountSnapshot.findMany({
    where: {
      capturedAt: { gte: since },
      ...(platform ? { account: { platform } } : {}),
    },
    orderBy: { capturedAt: "asc" },
  });
  // Sum by day across all accounts (typically 2 — IG + Threads).
  const byDay = new Map<string, number>();
  for (const s of snaps) {
    const d = new Date(s.capturedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    byDay.set(key, (byDay.get(key) ?? 0) + s.followers);
  }
  return Array.from(byDay.entries())
    .map(([date, followers]) => ({ date, followers }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
