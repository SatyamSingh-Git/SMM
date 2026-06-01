"use client";

import { useQuery } from "@tanstack/react-query";
import { Bookmark, Heart, Loader2, MessageCircle, Share2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = { platform?: Platform };

export function EngagementMixCard({ platform }: Props) {
  const q = useQuery({
    queryKey: ["dashboard", "engagement-mix", platform ?? "all"],
    queryFn: () => api.dashboardEngagementMix(platform),
    refetchOnWindowFocus: false,
    staleTime: 10 * 60_000,
  });
  const data = q.data;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight">Engagement mix</h3>
        <span className="text-[10px] text-[var(--fg-subtle)]">
          {platform ?? "all platforms"} · 30d
        </span>
      </div>
      {q.isLoading || !data ? (
        <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)] py-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : data.verdict === "no-data" ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--fg-muted)]">
          {data.interpretation}
        </div>
      ) : (
        <>
          <VerdictBadge verdict={data.verdict} />
          <div className="mt-3 grid grid-cols-4 gap-2">
            <Tile
              icon={Heart}
              label="Likes"
              pct={data.percentages.likes}
              total={data.totals.likes}
            />
            <Tile
              icon={MessageCircle}
              label="Comments"
              pct={data.percentages.comments}
              total={data.totals.comments}
            />
            <Tile
              icon={Bookmark}
              label="Saves"
              pct={data.percentages.saves}
              total={data.totals.saves + data.totals.reposts}
              accent
            />
            <Tile
              icon={Share2}
              label="Shares"
              pct={data.percentages.shares}
              total={data.totals.shares + data.totals.quotes}
              accent
            />
          </div>
          <div className="mt-3 rounded-lg bg-[var(--accent-soft)]/40 p-3 text-[12px] leading-relaxed">
            {data.interpretation}
          </div>
        </>
      )}
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  pct,
  total,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  pct: number;
  total: number;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-2 text-center",
        accent
          ? "border-[var(--accent)]/30 bg-[var(--accent-soft)]/30"
          : "border-[var(--border)] bg-[var(--surface-2)]"
      )}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5 mx-auto",
          accent ? "text-[var(--accent)]" : "text-[var(--fg-muted)]"
        )}
      />
      <div className="mt-1 text-base font-semibold leading-none">
        {pct.toFixed(0)}%
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--fg-muted)]">{label}</div>
      <div className="text-[10px] text-[var(--fg-subtle)]">
        {total.toLocaleString()}
      </div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const label =
    verdict === "save-heavy"
      ? "Save-heavy — evergreen-friendly audience"
      : verdict === "share-heavy"
        ? "Share-heavy — viral signal, ride it"
        : verdict === "comment-heavy"
          ? "Comment-heavy — conversational audience"
          : verdict === "like-heavy"
            ? "Like-heavy — passive scroll engagement"
            : "Mixed engagement";
  const tone =
    verdict === "like-heavy"
      ? "warning"
      : verdict === "save-heavy" || verdict === "share-heavy"
        ? "success"
        : "accent";
  const bg =
    tone === "success"
      ? "bg-[var(--success)]/12 text-[var(--success)] border-[var(--success)]/30"
      : tone === "warning"
        ? "bg-[var(--warning)]/12 text-[var(--warning)] border-[var(--warning)]/30"
        : "bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]/30";
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
        bg
      )}
    >
      {label}
    </div>
  );
}
