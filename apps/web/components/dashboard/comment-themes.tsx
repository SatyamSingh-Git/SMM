"use client";

import * as React from "react";
import { Lightbulb, Loader2, MessageCircle, RefreshCw, Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CommentThemes } from "@/lib/types";
import { cn } from "@/lib/utils";

const KEY = ["dashboard", "comment-themes"];

export function CommentThemesCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api.dashboardCommentThemes(false),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const refresh = useMutation({
    mutationFn: () => api.dashboardCommentThemes(true),
    onSuccess: (fresh) => qc.setQueryData(KEY, fresh),
  });

  const data = q.data;
  // "Never generated yet" — true empty state. Show Generate CTA.
  const neverGenerated = !data || data.empty || data.generatedAt === null;
  // "Generated, but the source pool was empty" — different state.
  // We DO have a payload (so .insight is set explaining why) but no data
  // to render the breakdown / clusters. Show the explanation, not the
  // generic "click Generate" UI.
  const generatedButEmpty =
    !neverGenerated &&
    data!.totalAnalyzed === 0 &&
    data!.sentimentBreakdown.length === 0 &&
    data!.topicClusters.length === 0;

  return (
    <Wrapper
      title="Comment themes"
      icon={MessageCircle}
      generatedAt={data?.generatedAt ?? null}
      onRefresh={() => refresh.mutate()}
      refreshing={refresh.isPending || q.isLoading}
      cost="~$0.002 per refresh"
    >
      {q.isLoading && !data ? (
        <Loading />
      ) : neverGenerated ? (
        <Empty
          text="No comment analysis yet."
          actionText="Generate"
          onAction={() => refresh.mutate()}
          busy={refresh.isPending}
        />
      ) : generatedButEmpty ? (
        <NoSourceData
          insight={
            data!.insight ||
            "0 comments in the database. The engagement worker stores comments from new Threads activity once it can connect to Redis. Run Sync now or wait for fresh comments to arrive."
          }
          onRetry={() => refresh.mutate()}
          retrying={refresh.isPending}
        />
      ) : (
        <div className="space-y-4">
          {data.insight && (
            <div className="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)]/30 p-3 text-sm">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--accent)] mb-1">
                <Sparkles className="h-3 w-3" /> So what
              </div>
              {data.insight}
            </div>
          )}

          {data.sentimentBreakdown.length > 0 && (
            <div>
              <SectionLabel>Sentiment breakdown</SectionLabel>
              <SentimentBars buckets={data.sentimentBreakdown} />
            </div>
          )}

          {data.topicClusters.length > 0 && (
            <div>
              <SectionLabel>What people keep asking about</SectionLabel>
              <div className="space-y-2 mt-1.5">
                {data.topicClusters.map((t, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-sm">{t.theme}</div>
                      <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--fg-muted)]">
                        {t.count} comments
                      </span>
                    </div>
                    {t.examples.length > 0 && (
                      <div className="mt-1.5 text-[11px] text-[var(--fg-subtle)] italic line-clamp-2">
                        &ldquo;{t.examples[0]}&rdquo;
                      </div>
                    )}
                    <div className="mt-2 flex items-start gap-1.5 rounded-md bg-[var(--accent-soft)]/40 px-2 py-1.5 text-[11px]">
                      <Lightbulb className="h-3 w-3 text-[var(--accent)] mt-0.5 shrink-0" />
                      <span className="text-fg">{t.contentIdea}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Wrapper>
  );
}

function SentimentBars({ buckets }: { buckets: CommentThemes["sentimentBreakdown"] }) {
  const total = buckets.reduce((acc, b) => acc + b.count, 0);
  if (total === 0) return null;
  const sorted = buckets.slice().sort((a, b) => b.count - a.count);
  return (
    <div className="mt-1.5 space-y-1.5">
      {sorted.map((b) => {
        const pct = total > 0 ? (b.count / total) * 100 : 0;
        return (
          <div key={b.label}>
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium">{b.label}</span>
              <span className="text-[var(--fg-muted)]">
                {b.count} · {pct.toFixed(0)}%
              </span>
            </div>
            <div className="mt-0.5 h-1.5 w-full rounded-full bg-[var(--surface-2)] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[var(--accent)] to-[var(--accent)]/60"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Wrapper(props: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  generatedAt: string | null;
  onRefresh: () => void;
  refreshing?: boolean;
  cost?: string;
  children: React.ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="text-sm font-semibold tracking-tight">{props.title}</h3>
        </div>
        <div className="flex items-center gap-2">
          {props.generatedAt && (
            <span className="text-[10px] text-[var(--fg-subtle)]">
              {ago(props.generatedAt)} ago
            </span>
          )}
          <button
            type="button"
            onClick={props.onRefresh}
            disabled={props.refreshing}
            title={props.cost ? `Regenerate · ${props.cost}` : "Regenerate"}
            className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-[var(--fg-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-50"
          >
            {props.refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
      {props.children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)] py-2">
      <Loader2 className="h-4 w-4 animate-spin" /> Analyzing comments…
    </div>
  );
}

function NoSourceData({
  insight,
  onRetry,
  retrying,
}: {
  insight: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--warning)]/30 bg-[var(--warning)]/8 p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--warning)] mb-1 font-medium">
        Generated, but no data to analyze
      </div>
      <div className="text-sm leading-relaxed">{insight}</div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        Try again
      </button>
    </div>
  );
}

function Empty({
  text,
  actionText,
  onAction,
  busy,
}: {
  text: string;
  actionText: string;
  onAction: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center">
      <div className="text-xs text-[var(--fg-muted)] mb-2">{text}</div>
      <button
        type="button"
        onClick={onAction}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1.5 text-xs font-medium text-[var(--accent)]",
          "hover:bg-[var(--accent)] hover:text-white transition-colors disabled:opacity-50"
        )}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        {actionText}
      </button>
    </div>
  );
}

function ago(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
