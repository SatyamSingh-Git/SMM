import { prisma, type Platform } from "@smm/db";

// Saves vs Shares vs Likes vs Comments breakdown. Pure SQL aggregation.
// Different actions signal different things — this is a key creator
// insight a lot of dashboards skip:
//   - save-heavy   = "I want to come back to this" (evergreen content)
//   - share-heavy  = "everyone needs to see this" (viral content)
//   - like-heavy   = passive scrolling (lower-signal engagement)
//   - comment-heavy = conversational content (good for replies feature)

const ONE_DAY = 24 * 60 * 60 * 1000;

export type EngagementMix = {
  platform: Platform | "all";
  days: number;
  postsCounted: number;
  totals: {
    likes: number;
    comments: number;
    saves: number;
    shares: number;
    // Threads-only signals (counted into mix totals where applicable)
    reposts: number;
    quotes: number;
  };
  // Percent of total engagement actions that fell into each bucket.
  // Sum = 100.
  percentages: {
    likes: number;
    comments: number;
    saves: number;
    shares: number;
  };
  // Verdict tag the UI uses to color-code the card.
  verdict: "save-heavy" | "share-heavy" | "comment-heavy" | "like-heavy" | "mixed" | "no-data";
  // 1-2 sentence interpretation — no AI, just templated based on verdict.
  interpretation: string;
};

export async function getEngagementMix(opts?: {
  platform?: Platform;
  days?: number;
}): Promise<EngagementMix> {
  const days = opts?.days ?? 30;
  const since = new Date(Date.now() - days * ONE_DAY);

  const posts = await prisma.post.findMany({
    where: {
      status: "published",
      updatedAt: { gte: since },
      ...(opts?.platform ? { platform: opts.platform } : {}),
    },
    include: { insights: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });

  let likes = 0;
  let comments = 0;
  let saves = 0;
  let shares = 0;
  let reposts = 0;
  let quotes = 0;
  let counted = 0;
  for (const p of posts) {
    const ins = p.insights[0];
    if (!ins) continue;
    counted++;
    likes += ins.likes ?? 0;
    comments += ins.comments ?? 0;
    saves += ins.saves ?? 0;
    shares += ins.shares ?? 0;
    reposts += ins.reposts ?? 0;
    quotes += ins.quotes ?? 0;
  }
  const total = likes + comments + saves + shares + reposts + quotes;
  if (total === 0) {
    return {
      platform: opts?.platform ?? "all",
      days,
      postsCounted: counted,
      totals: { likes, comments, saves, shares, reposts, quotes },
      percentages: { likes: 0, comments: 0, saves: 0, shares: 0 },
      verdict: "no-data",
      interpretation:
        "Not enough engagement data yet — capture insights for more posts to see your mix.",
    };
  }

  const pct = (n: number) => Math.round((n / total) * 1000) / 10;
  const percentages = {
    likes: pct(likes),
    comments: pct(comments),
    // Saves only exist on IG; on Threads side, reposts play that "stash it" role.
    saves: pct(saves + reposts),
    // Shares include Threads quotes (sharing with commentary).
    shares: pct(shares + quotes),
  };

  // Verdict picks the dominant non-likes signal (likes are the easy default —
  // we want to know whether the user is generating "real" engagement).
  const high = Math.max(percentages.saves, percentages.shares, percentages.comments);
  let verdict: EngagementMix["verdict"];
  let interpretation = "";
  if (high < 8) {
    verdict = "like-heavy";
    interpretation =
      "Engagement is mostly passive likes. To pull people deeper, try posts that bait comments (a question), shares (a relatable observation), or saves (a useful OOTD / get-ready format).";
  } else if (percentages.saves >= percentages.shares && percentages.saves >= percentages.comments) {
    verdict = "save-heavy";
    interpretation =
      "People are saving your content — that's high intent. Lean into formats they'd want to come back to: outfit details, tutorials, mini lookbooks.";
  } else if (percentages.shares >= percentages.comments) {
    verdict = "share-heavy";
    interpretation =
      "Your audience shares. That's a viral signal. Keep mining relatable observations / 'agree or fight me' takes / POV hooks — these print.";
  } else {
    verdict = "comment-heavy";
    interpretation =
      "Comments dominate — your audience wants to talk. Great for the auto-reply pipeline. Try posts that explicitly invite responses (open-ended Q's, polls in caption).";
  }

  return {
    platform: opts?.platform ?? "all",
    days,
    postsCounted: counted,
    totals: { likes, comments, saves, shares, reposts, quotes },
    percentages,
    verdict,
    interpretation,
  };
}
