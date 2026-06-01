"use client";

import type { TypeBreakdownRow } from "@/lib/types";

const LABEL: Record<string, string> = {
  ig_feed: "IG Feed",
  ig_carousel: "Carousel",
  ig_reel: "Reel",
  ig_story: "Story",
  threads_post: "Thread",
  threads_reply_chain: "Reply chain",
};

type Props = { data?: TypeBreakdownRow[]; loading?: boolean };

export function TypeBreakdown({ data, loading }: Props) {
  const max = data ? Math.max(1, ...data.map((r) => r.avgEngagement)) : 1;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight">What works best</h3>
        <span className="text-[11px] text-[var(--fg-subtle)]">
          avg engagement by content type · 30d
        </span>
      </div>
      {loading && !data ? (
        <div className="text-xs text-[var(--fg-muted)]">Loading…</div>
      ) : !data || data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--fg-muted)]">
          Need more data — at least a few posts of each type to compare.
        </div>
      ) : (
        <div className="space-y-2">
          {data.map((r) => (
            <div key={r.type}>
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{LABEL[r.type] ?? r.type}</span>
                <span className="text-[var(--fg-muted)]">
                  {r.avgEngagement.toLocaleString()} avg eng · {r.count} post
                  {r.count === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mt-1 h-2 w-full rounded-full bg-[var(--surface-2)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[var(--accent)] to-[var(--accent)]/60"
                  style={{ width: `${Math.max(4, (r.avgEngagement / max) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
