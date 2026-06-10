"use client";

import { ArrowDownRight, ArrowUpRight, Eye, MessageCircle, TrendingUp, Users } from "lucide-react";
import type { DashboardKpis } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = { data?: DashboardKpis; loading?: boolean };

export function KpiStrip({ data, loading }: Props) {
  const items: Array<{
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string;
    delta?: { text: string; positive: boolean } | null;
    hint?: string;
  }> = [
    {
      icon: Users,
      label: "Followers",
      value: data ? fmt(data.followers.current) : "—",
      // Only show a delta if we actually have enough history. Otherwise
      // surface a "tracking started" hint so the user knows it's not yet.
      delta:
        data && data.followers.delta14d !== null
          ? {
              text: `${data.followers.delta14d >= 0 ? "+" : ""}${fmt(data.followers.delta14d)} / 14d`,
              positive: data.followers.delta14d >= 0,
            }
          : null,
      hint:
        data && data.followers.delta14d === null
          ? data.followers.historyDays === 0
            ? "tracking starts today — sync daily for growth trend"
            : `tracking started ${data.followers.historyDays}d ago — need 7+ days for trend`
          : undefined,
    },
    {
      icon: Eye,
      label: "Reach (7d)",
      value: data ? fmt(data.reach7d) : "—",
      hint: data ? `${data.postsPublished7d} posts published` : undefined,
    },
    {
      icon: TrendingUp,
      label: "Engagement rate",
      value:
        data?.engagementRate != null
          ? `${data.engagementRate.toFixed(1)}%`
          : data
            ? "—"
            : "—",
      // Share rate is the strongest reach signal in 2026 — surface it (and the
      // IG-only save rate) right under the headline engagement number.
      hint:
        data && (data.shareRate7d != null || data.saveRate7d != null)
          ? [
              data.shareRate7d != null
                ? `shares ${data.shareRate7d.toFixed(2)}%`
                : null,
              data.saveRate7d != null
                ? `saves ${data.saveRate7d.toFixed(2)}%`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") + " of reach"
          : "of reach (likes + comments + saves + shares)",
    },
    {
      icon: MessageCircle,
      label: "Replies (7d)",
      value: data ? fmt(data.repliesHandled.replied) : "—",
      hint: data
        ? `${data.repliesHandled.replied} replied · ${data.repliesHandled.skipped} skipped · ${data.repliesHandled.failed} failed`
        : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <div
            key={it.label}
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
                {it.label}
              </div>
              <Icon className="h-4 w-4 text-[var(--fg-subtle)]" />
            </div>
            <div className="mt-2 text-2xl font-semibold tracking-tight">
              {loading ? <span className="text-[var(--fg-subtle)]">…</span> : it.value}
            </div>
            {it.delta && (
              <div
                className={cn(
                  "mt-1 inline-flex items-center gap-1 text-xs font-medium",
                  it.delta.positive
                    ? "text-[var(--success)]"
                    : "text-[var(--danger)]"
                )}
              >
                {it.delta.positive ? (
                  <ArrowUpRight className="h-3.5 w-3.5" />
                ) : (
                  <ArrowDownRight className="h-3.5 w-3.5" />
                )}
                {it.delta.text}
              </div>
            )}
            {it.hint && (
              <div className="mt-1 text-[11px] text-[var(--fg-subtle)] line-clamp-1">
                {it.hint}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
