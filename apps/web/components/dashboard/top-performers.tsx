"use client";

import { Camera, Eye, Heart, MessageCircle as Msg, Save, Share2 } from "lucide-react";
import type { TopPostRow } from "@/lib/types";
import { PlatformBadge } from "@/components/platform-badge";
import { cn } from "@/lib/utils";

type Props = { posts?: TopPostRow[]; loading?: boolean };

export function TopPerformers({ posts, loading }: Props) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight">Top performers</h3>
        <span className="text-[11px] text-[var(--fg-subtle)]">last 30 days</span>
      </div>
      {loading && !posts ? (
        <div className="text-xs text-[var(--fg-muted)]">Loading…</div>
      ) : !posts || posts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--fg-muted)]">
          No posts with insights yet. The dashboard auto-syncs new metrics every
          15 min after a post goes live.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {posts.slice(0, 6).map((p) => (
            <a
              key={p.id}
              href={p.platformUrl ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="group rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden hover:border-[var(--accent)] transition-colors"
            >
              {/* Thumbnail */}
              <div className="aspect-square bg-[var(--surface)] relative">
                {p.thumbnailUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={p.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full grid place-items-center text-[var(--fg-subtle)]">
                    <Camera className="h-6 w-6" />
                  </div>
                )}
                <div className="absolute top-2 left-2">
                  <PlatformBadge platform={p.platform} size="sm" />
                </div>
                <div
                  className={cn(
                    "absolute top-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-medium",
                    "bg-black/70 text-white"
                  )}
                >
                  {p.engagement.toLocaleString()} eng
                </div>
              </div>
              {/* Metrics row */}
              <div className="p-2 space-y-1">
                {p.caption && (
                  <div className="text-[11px] text-fg/90 line-clamp-2 leading-snug">
                    {p.caption}
                  </div>
                )}
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[var(--fg-muted)]">
                  {(p.reach != null || p.views != null) && (
                    <Stat icon={Eye} value={p.reach ?? p.views ?? 0} />
                  )}
                  {p.likes != null && <Stat icon={Heart} value={p.likes} />}
                  {p.comments != null && <Stat icon={Msg} value={p.comments} />}
                  {p.saves != null && <Stat icon={Save} value={p.saves} />}
                  {p.shares != null && <Stat icon={Share2} value={p.shares} />}
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: number;
}) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <Icon className="h-3 w-3" />
      {value.toLocaleString()}
    </span>
  );
}
