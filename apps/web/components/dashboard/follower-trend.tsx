"use client";

import type { FollowerTrendPoint } from "@/lib/types";

type Props = { data?: FollowerTrendPoint[]; loading?: boolean };

// Tiny pure-SVG line chart. No charting library — keeps bundle small and
// matches our minimalist design tokens.
export function FollowerTrend({ data, loading }: Props) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight">Follower growth</h3>
        <span className="text-[11px] text-[var(--fg-subtle)]">last 60 days</span>
      </div>
      {loading && !data ? (
        <div className="text-xs text-[var(--fg-muted)]">Loading…</div>
      ) : !data || data.length < 2 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--fg-muted)]">
          Need at least 2 days of snapshots — dashboard takes daily automatically,
          give it 24-48h.
        </div>
      ) : (
        <Sparkline points={data} />
      )}
    </div>
  );
}

function Sparkline({ points }: { points: FollowerTrendPoint[] }) {
  const W = 600;
  const H = 160;
  const PAD = 20;
  const ys = points.map((p) => p.followers);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const range = Math.max(1, maxY - minY);
  const stepX = (W - PAD * 2) / Math.max(1, points.length - 1);
  const path = points
    .map((p, i) => {
      const x = PAD + i * stepX;
      const y = PAD + (1 - (p.followers - minY) / range) * (H - PAD * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `${path} L${PAD + (points.length - 1) * stepX},${H - PAD} L${PAD},${H - PAD} Z`;
  const last = points[points.length - 1];
  const first = points[0];
  const delta = last && first ? last.followers - first.followers : 0;

  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-xs">
        <div className="text-[var(--fg-muted)]">Now</div>
        <div className="text-base font-semibold">
          {last?.followers.toLocaleString()}
        </div>
        <div
          className={
            delta >= 0
              ? "text-[var(--success)] font-medium"
              : "text-[var(--danger)] font-medium"
          }
        >
          {delta >= 0 ? "+" : ""}
          {delta.toLocaleString()} total
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        preserveAspectRatio="none"
      >
        <path d={area} fill="var(--accent-soft)" opacity={0.5} />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} />
      </svg>
    </div>
  );
}
