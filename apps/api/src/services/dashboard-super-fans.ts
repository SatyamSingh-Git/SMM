import { prisma } from "@smm/db";

// Pure SQL — find the people who comment most on the user's posts in the
// last 30 days. These are warm leads to convert into proper followers/fans:
// DM them, reply manually, feature them.

const ONE_DAY = 24 * 60 * 60 * 1000;

export type SuperFan = {
  authorPlatformId: string | null;
  authorUsername: string | null;
  commentCount: number;
  // Last comment received from them (for context).
  lastCommentAt: string;
  lastCommentText: string;
  // Number of distinct posts of yours they've commented on (broader engagement signal).
  postsEngagedOn: number;
};

export async function getSuperFans(opts?: {
  days?: number;
  limit?: number;
}): Promise<SuperFan[]> {
  const days = opts?.days ?? 30;
  const limit = opts?.limit ?? 12;
  const since = new Date(Date.now() - days * ONE_DAY);

  // Pull all comments in the window — for small accounts this is cheap.
  // Aggregating in memory keeps Prisma query simple (no $queryRaw needed).
  const rows = await prisma.engagementComment.findMany({
    where: { receivedAt: { gte: since } },
    orderBy: { receivedAt: "desc" },
    select: {
      authorPlatformId: true,
      authorUsername: true,
      text: true,
      receivedAt: true,
      platformPostId: true,
    },
  });

  type Agg = {
    authorPlatformId: string | null;
    authorUsername: string | null;
    commentCount: number;
    lastCommentAt: Date;
    lastCommentText: string;
    postIds: Set<string>;
  };
  const map = new Map<string, Agg>();
  for (const r of rows) {
    // Anchor on platform id if available, else username, else skip.
    const key = r.authorPlatformId ?? r.authorUsername ?? "";
    if (!key) continue;
    const cur =
      map.get(key) ??
      ({
        authorPlatformId: r.authorPlatformId,
        authorUsername: r.authorUsername,
        commentCount: 0,
        lastCommentAt: r.receivedAt,
        lastCommentText: r.text,
        postIds: new Set<string>(),
      } as Agg);
    cur.commentCount += 1;
    cur.postIds.add(r.platformPostId);
    if (r.receivedAt > cur.lastCommentAt) {
      cur.lastCommentAt = r.receivedAt;
      cur.lastCommentText = r.text;
    }
    if (!cur.authorUsername && r.authorUsername) cur.authorUsername = r.authorUsername;
    map.set(key, cur);
  }

  return Array.from(map.values())
    .filter((v) => v.commentCount >= 2) // only show actual fans, not one-offs
    .sort((a, b) => b.commentCount - a.commentCount)
    .slice(0, limit)
    .map((v) => ({
      authorPlatformId: v.authorPlatformId,
      authorUsername: v.authorUsername,
      commentCount: v.commentCount,
      lastCommentAt: v.lastCommentAt.toISOString(),
      lastCommentText: v.lastCommentText,
      postsEngagedOn: v.postIds.size,
    }));
}
