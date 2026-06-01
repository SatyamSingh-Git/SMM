import { prisma, type Platform, type PostType } from "@smm/db";

// "This post is breaking out — ride it." Pure SQL detection: compares a
// recent post's engagement to the user's median for the same platform+type
// over the prior weeks. If the recent post is ≥2× the median AND it's still
// young (<24h), flag it.

const ONE_DAY = 24 * 60 * 60 * 1000;

export type MomentumPost = {
  postId: string;
  platform: Platform;
  type: PostType;
  platformUrl: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  publishedAt: string;
  engagement: number;
  // Median engagement for this user's posts of the same platform+type, last 30d.
  // Excludes the current post itself.
  baseline: number;
  multiple: number; // engagement / baseline (rounded 1 decimal)
};

export async function getMomentumPosts(): Promise<MomentumPost[]> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since30d = new Date(Date.now() - 30 * ONE_DAY);

  // Recent posts to evaluate.
  const recent = await prisma.post.findMany({
    where: {
      status: "published",
      updatedAt: { gte: since24h },
    },
    include: {
      insights: { orderBy: { capturedAt: "desc" }, take: 1 },
      assets: {
        orderBy: { position: "asc" },
        take: 1,
        include: { asset: true },
      },
    },
  });

  if (recent.length === 0) return [];

  // Baseline pool: all posts in last 30 days with insights, grouped by platform+type.
  const baselinePool = await prisma.post.findMany({
    where: {
      status: "published",
      updatedAt: { gte: since30d },
    },
    include: { insights: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });

  const baselineBy = new Map<string, number[]>();
  for (const p of baselinePool) {
    const ins = p.insights[0];
    if (!ins) continue;
    const eng =
      (ins.likes ?? 0) +
      (ins.comments ?? 0) +
      (ins.saves ?? 0) +
      (ins.shares ?? 0) +
      (ins.reposts ?? 0) +
      (ins.quotes ?? 0);
    const key = `${p.platform}:${p.type}`;
    const arr = baselineBy.get(key) ?? [];
    arr.push(eng);
    baselineBy.set(key, arr);
  }

  const out: MomentumPost[] = [];
  for (const p of recent) {
    const ins = p.insights[0];
    if (!ins) continue;
    const eng =
      (ins.likes ?? 0) +
      (ins.comments ?? 0) +
      (ins.saves ?? 0) +
      (ins.shares ?? 0) +
      (ins.reposts ?? 0) +
      (ins.quotes ?? 0);
    if (eng === 0) continue;
    const key = `${p.platform}:${p.type}`;
    // Build a baseline excluding the post itself.
    const peers = (baselineBy.get(key) ?? []).filter((v) => v !== eng);
    if (peers.length < 3) continue; // need at least a few peers to call a baseline
    const baseline = median(peers);
    if (baseline === 0) continue;
    const multiple = Math.round((eng / baseline) * 10) / 10;
    if (multiple < 2) continue;

    out.push({
      postId: p.id,
      platform: p.platform,
      type: p.type,
      platformUrl: p.platformUrl,
      caption: p.caption,
      thumbnailUrl: p.assets[0]?.asset.publicUrl ?? null,
      publishedAt: p.updatedAt.toISOString(),
      engagement: eng,
      baseline,
      multiple,
    });
  }

  return out.sort((a, b) => b.multiple - a.multiple);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : sorted[mid] ?? 0;
}
