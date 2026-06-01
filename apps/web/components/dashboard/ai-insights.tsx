"use client";

import * as React from "react";
import {
  AlertTriangle,
  Lightbulb,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
  Trophy,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { DashboardAiInsights, Platform } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Props = { platform: Platform };

type Tab = "wins" | "warnings" | "tryNext";

export function AiInsightsCard({ platform }: Props) {
  const qc = useQueryClient();
  const KEY = ["dashboard", platform, "ai-insights"];
  // Manual-refresh-only: no background refetch (saves DeepSeek tokens). The
  // page-level "Sync now" regenerates this on the server and invalidates us.
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api.dashboardAiInsights(platform, false),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    staleTime: Infinity,
  });
  const data = q.data;
  const loading = q.isLoading;
  const refresh = useMutation({
    mutationFn: () => api.dashboardAiInsights(platform, true),
    onSuccess: (fresh) => {
      qc.setQueryData(KEY, fresh);
    },
  });
  const [tab, setTab] = React.useState<Tab>("wins");
  const platformLabel = platform === "instagram" ? "Instagram" : "Threads";

  if (loading && !data) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Analyzing your performance…
        </div>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Weekly focus — the hero card */}
      <div className="rounded-2xl border border-[var(--accent)]/30 bg-gradient-to-br from-[var(--accent-soft)] to-[var(--surface)] p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--accent)]">
              <Target className="h-3.5 w-3.5" /> Focus this week · {platformLabel}
            </div>
            <p className="mt-2 text-lg leading-snug font-semibold">
              {data.weeklyFocus}
            </p>
            <div className="mt-2 text-[11px] text-[var(--fg-subtle)]">
              Based on {data.basedOn.postsAnalyzed} posts across{" "}
              {data.basedOn.daysOfData} days · updated{" "}
              {new Date(data.generatedAt).toLocaleString(undefined, {
                hour: "numeric",
                minute: "numeric",
                day: "numeric",
                month: "short",
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="grid h-8 w-8 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-50"
            title="Regenerate insights with latest data"
          >
            {refresh.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Score card */}
      <div className="grid grid-cols-3 gap-3">
        {(["consistency", "engagement", "growth"] as const).map((k) => {
          const s = data.scoreCard[k];
          return (
            <div
              key={k}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
                  {k}
                </div>
                <div
                  className={cn(
                    "text-2xl font-bold leading-none",
                    s.grade === "A"
                      ? "text-[var(--success)]"
                      : s.grade === "B"
                        ? "text-[var(--accent)]"
                        : s.grade === "C"
                          ? "text-[var(--warning)]"
                          : "text-[var(--danger)]"
                  )}
                >
                  {s.grade}
                </div>
              </div>
              <div className="mt-1 text-[11px] text-[var(--fg-muted)] line-clamp-3">
                {s.note}
              </div>
            </div>
          );
        })}
      </div>

      {/* Tabbed insights */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="flex border-b border-[var(--border)]">
          <TabBtn
            active={tab === "wins"}
            onClick={() => setTab("wins")}
            icon={Trophy}
            label="What's working"
            count={data.wins.length}
            tone="success"
          />
          <TabBtn
            active={tab === "warnings"}
            onClick={() => setTab("warnings")}
            icon={AlertTriangle}
            label="Watch out"
            count={data.warnings.length}
            tone="warning"
          />
          <TabBtn
            active={tab === "tryNext"}
            onClick={() => setTab("tryNext")}
            icon={Lightbulb}
            label="Try next"
            count={data.tryNext.length}
            tone="accent"
          />
        </div>
        <div className="p-4 space-y-2.5">
          {tab === "wins" &&
            (data.wins.length === 0 ? (
              <Empty text="No wins surfaced yet — keep posting and I'll spot the patterns." />
            ) : (
              data.wins.map((w, i) => <InsightCard key={i} {...w} tone="success" />)
            ))}
          {tab === "warnings" &&
            (data.warnings.length === 0 ? (
              <Empty text="Nothing concerning right now." />
            ) : (
              data.warnings.map((w, i) => (
                <InsightCard key={i} {...w} tone="warning" />
              ))
            ))}
          {tab === "tryNext" &&
            (data.tryNext.length === 0 ? (
              <Empty text="No fresh ideas — try posting a few different things and check back." />
            ) : (
              data.tryNext.map((t, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)]/30 p-3"
                >
                  <div className="font-medium text-sm">{t.title}</div>
                  <div className="mt-1 text-[12px] text-[var(--fg-muted)] leading-relaxed">
                    {t.why}
                  </div>
                  {t.exampleCaption && (
                    <div className="mt-2 rounded-md bg-[var(--surface)] border border-[var(--border)] p-2 text-[12px] italic">
                      &ldquo;{t.exampleCaption}&rdquo;
                    </div>
                  )}
                </div>
              ))
            ))}
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon: Icon,
  label,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  tone: "success" | "warning" | "accent";
}) {
  const toneColor =
    tone === "success"
      ? "var(--success)"
      : tone === "warning"
        ? "var(--warning)"
        : "var(--accent)";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
        active
          ? "border-current"
          : "border-transparent text-[var(--fg-muted)] hover:text-fg"
      )}
      style={active ? { color: toneColor, borderColor: toneColor } : undefined}
    >
      <Icon className="h-4 w-4" /> {label}
      <span className="text-[10px] rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[var(--fg-muted)]">
        {count}
      </span>
    </button>
  );
}

function InsightCard({
  title,
  detail,
  evidence,
  tone,
}: {
  title: string;
  detail: string;
  evidence?: string;
  tone: "success" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        tone === "success"
          ? "border-[var(--success)]/30 bg-[var(--success)]/8"
          : "border-[var(--warning)]/30 bg-[var(--warning)]/8"
      )}
    >
      <div className="font-medium text-sm">{title}</div>
      <div className="mt-1 text-[12px] text-[var(--fg-muted)] leading-relaxed">
        {detail}
      </div>
      {evidence && (
        <div className="mt-2 text-[11px] text-[var(--fg-subtle)] italic">
          {evidence}
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--fg-muted)]">
      {text}
    </div>
  );
}
