"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Sparkles,
  Type,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = { platform: Platform };

export function CaptionPatternsCard({ platform }: Props) {
  const qc = useQueryClient();
  const KEY = ["dashboard", platform, "caption-patterns"];
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api.dashboardCaptionPatterns(platform, false),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const refresh = useMutation({
    mutationFn: () => api.dashboardCaptionPatterns(platform, true),
    onSuccess: (fresh) => qc.setQueryData(KEY, fresh),
  });
  const [copied, setCopied] = React.useState<number | null>(null);

  const data = q.data;
  const neverGenerated = !data || data.empty || data.generatedAt === null;
  // We DID run, but the source pool was empty (no posts with insights).
  const generatedButEmpty =
    !neverGenerated &&
    data!.doMore.length === 0 &&
    data!.doLess.length === 0 &&
    data!.templateExamples.length === 0;

  function copy(text: string, i: number) {
    void navigator.clipboard.writeText(text);
    setCopied(i);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Type className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="text-sm font-semibold tracking-tight">
            What's working in your captions
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {data?.generatedAt && (
            <span className="text-[10px] text-[var(--fg-subtle)]">
              {ago(data.generatedAt)} ago
            </span>
          )}
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            title="Regenerate · ~$0.0015 per refresh"
            className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-[var(--fg-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-50"
          >
            {refresh.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {q.isLoading && !data ? (
        <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)] py-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : neverGenerated ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center">
          <div className="text-xs text-[var(--fg-muted)] mb-2">
            No pattern analysis yet.
          </div>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1.5 text-xs font-medium text-[var(--accent)]",
              "hover:bg-[var(--accent)] hover:text-white transition-colors disabled:opacity-50"
            )}
          >
            {refresh.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Generate
          </button>
        </div>
      ) : generatedButEmpty ? (
        <div className="rounded-xl border border-[var(--warning)]/30 bg-[var(--warning)]/8 p-3">
          <div className="text-[10px] uppercase tracking-wider text-[var(--warning)] mb-1 font-medium">
            Generated, but no data to analyze
          </div>
          <div className="text-sm leading-relaxed">
            {data!.note ||
              `Found ${data!.postsAnalyzed ?? 0} posts with insight metrics — need at least a few before pattern detection works.`}
          </div>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            {refresh.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Try again
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {data.doMore.length > 0 && (
            <div>
              <SectionLabel tone="success">Do more of</SectionLabel>
              <div className="mt-1.5 space-y-2">
                {data.doMore.map((o, i) => (
                  <Pattern key={i} obs={o} tone="success" />
                ))}
              </div>
            </div>
          )}
          {data.doLess.length > 0 && (
            <div>
              <SectionLabel tone="danger">Cut back on</SectionLabel>
              <div className="mt-1.5 space-y-2">
                {data.doLess.map((o, i) => (
                  <Pattern key={i} obs={o} tone="danger" />
                ))}
              </div>
            </div>
          )}
          {data.templateExamples.length > 0 && (
            <div>
              <SectionLabel>Templates to copy</SectionLabel>
              <div className="mt-1.5 space-y-1.5">
                {data.templateExamples.map((t, i) => (
                  <div
                    key={i}
                    className="group flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-sm"
                  >
                    <div className="flex-1 min-w-0 italic">&ldquo;{t}&rdquo;</div>
                    <button
                      type="button"
                      onClick={() => copy(t, i)}
                      className="grid h-6 w-6 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)] shrink-0"
                      title="Copy"
                    >
                      {copied === i ? (
                        <Check className="h-3 w-3 text-[var(--success)]" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Pattern({
  obs,
  tone,
}: {
  obs: { title: string; detail: string; evidence: string };
  tone: "success" | "danger";
}) {
  const Icon = tone === "success" ? Check : X;
  return (
    <div
      className={cn(
        "rounded-lg border p-2.5",
        tone === "success"
          ? "border-[var(--success)]/30 bg-[var(--success)]/8"
          : "border-[var(--danger)]/30 bg-[var(--danger)]/8"
      )}
    >
      <div className="flex items-start gap-1.5">
        <Icon
          className={cn(
            "h-3.5 w-3.5 mt-0.5 shrink-0",
            tone === "success" ? "text-[var(--success)]" : "text-[var(--danger)]"
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{obs.title}</div>
          <div className="mt-0.5 text-[12px] text-[var(--fg-muted)]">
            {obs.detail}
          </div>
          {obs.evidence && (
            <div className="mt-1 text-[11px] text-[var(--fg-subtle)] italic">
              {obs.evidence}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "success" | "danger";
}) {
  return (
    <div
      className={cn(
        "text-[10px] uppercase tracking-wider font-medium",
        tone === "success"
          ? "text-[var(--success)]"
          : tone === "danger"
            ? "text-[var(--danger)]"
            : "text-[var(--fg-muted)]"
      )}
    >
      {children}
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
