"use client";

import { useQuery } from "@tanstack/react-query";
import { Camera, MessageCircle } from "lucide-react";
import { KpiStrip } from "./kpi-strip";
import { TopPerformers } from "./top-performers";
import { TypeBreakdown } from "./type-breakdown";
import { FollowerTrend } from "./follower-trend";
import { PostingHeatmap } from "./posting-heatmap";
import { EngagementMixCard } from "./engagement-mix";
import { AiInsightsCard } from "./ai-insights";
import { CaptionPatternsCard } from "./caption-patterns";
import { api } from "@/lib/api";
import type { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  platform: Platform;
};

// One full per-platform analytics section. Loads its own KPIs/posts/trends
// scoped to either Instagram or Threads. Self-contained — drop two of these
// on the page and you get a complete IG + Threads split.
export function PlatformSection({ platform }: Props) {
  const kpisQ = useQuery({
    queryKey: ["dashboard", platform, "kpis"],
    queryFn: () => api.dashboardKpis(platform),
    refetchInterval: 5 * 60_000,
  });
  const topPostsQ = useQuery({
    queryKey: ["dashboard", platform, "top"],
    queryFn: () => api.dashboardTopPosts(30, platform),
    refetchInterval: 10 * 60_000,
  });
  const typeQ = useQuery({
    queryKey: ["dashboard", platform, "type"],
    queryFn: () => api.dashboardTypeBreakdown(platform),
    refetchInterval: 30 * 60_000,
  });
  const trendQ = useQuery({
    queryKey: ["dashboard", platform, "trend"],
    queryFn: () => api.dashboardFollowerTrend(platform),
    refetchInterval: 30 * 60_000,
  });
  const heatmapQ = useQuery({
    queryKey: ["dashboard", platform, "heatmap"],
    queryFn: () => api.dashboardHeatmap(platform),
    refetchInterval: 30 * 60_000,
  });
  const bestTimesQ = useQuery({
    queryKey: ["dashboard", platform, "best-times"],
    queryFn: () => api.dashboardBestTimes(platform),
    refetchInterval: 60 * 60_000,
  });

  const isIg = platform === "instagram";
  const Icon = isIg ? Camera : MessageCircle;
  const accentColor = isIg ? "var(--instagram)" : "var(--threads)";
  const label = isIg ? "Instagram" : "Threads";

  return (
    <section
      className={cn(
        "rounded-3xl border bg-[var(--surface-2)]/40 p-4 sm:p-5 space-y-4",
        "border-[var(--border)]"
      )}
    >
      <header className="flex items-center gap-2">
        <div
          className="grid h-8 w-8 place-items-center rounded-lg"
          style={{ background: `color-mix(in oklab, ${accentColor} 12%, transparent)`, color: accentColor }}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <h2 className="text-base font-semibold tracking-tight">{label}</h2>
          <div className="text-[11px] text-[var(--fg-muted)]">
            Last 7-30 days · scoped to this platform
          </div>
        </div>
      </header>

      {/* Per-platform AI insights — the hero for this platform. */}
      <AiInsightsCard platform={platform} />

      <KpiStrip data={kpisQ.data} loading={kpisQ.isLoading} />

      <div className="grid lg:grid-cols-2 gap-4">
        <TopPerformers posts={topPostsQ.data} loading={topPostsQ.isLoading} />
        <div className="space-y-4">
          <FollowerTrend data={trendQ.data} loading={trendQ.isLoading} />
          <TypeBreakdown data={typeQ.data} loading={typeQ.isLoading} />
          <EngagementMixCard platform={platform} />
        </div>
      </div>

      {/* What's working in this platform's captions. */}
      <CaptionPatternsCard platform={platform} />

      <BestTimesCallout data={bestTimesQ.data} />
      <PostingHeatmap data={heatmapQ.data} loading={heatmapQ.isLoading} />
    </section>
  );
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function fmtHour(h: number): string {
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${am ? "AM" : "PM"}`;
}
function BestTimesCallout({
  data,
}: {
  data?: import("@/lib/types").BestTimes;
}) {
  if (!data || data.slots.length === 0) return null;
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
          Best times to post · IST
        </div>
        <div className="text-[11px] text-[var(--fg-subtle)]">
          from {data.totalPosts} posts · ≥{data.minSamples}/slot
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {data.slots.map((s) => (
          <span
            key={`${s.dayOfWeek}-${s.hourIst}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] text-[var(--accent)]"
            title={`avg engagement ${s.avgEngagement} across ${s.samples} posts`}
          >
            {DOW[s.dayOfWeek]} {fmtHour(s.hourIst)}
            <span className="text-[var(--fg-subtle)]">~{s.avgEngagement}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
