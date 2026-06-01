"use client";

import { useQuery } from "@tanstack/react-query";
import { Camera, Flame, MessageCircle as Msg } from "lucide-react";
import { api } from "@/lib/api";

export function MomentumCard() {
  const q = useQuery({
    queryKey: ["dashboard", "momentum"],
    queryFn: api.dashboardMomentum,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const posts = q.data ?? [];
  if (posts.length === 0) return null;

  return (
    <div className="rounded-2xl border border-orange-500/30 bg-gradient-to-br from-orange-500/10 to-[var(--surface)] p-4">
      <div className="mb-2 flex items-center gap-2">
        <Flame className="h-4 w-4 text-orange-500" />
        <h3 className="text-sm font-semibold tracking-tight text-orange-500">
          🔥 Breaking out
        </h3>
        <span className="text-[10px] text-[var(--fg-muted)]">
          (≥2× your baseline)
        </span>
      </div>
      <div className="text-[11px] text-[var(--fg-muted)] mb-3">
        Recent posts pulling far above your usual. Ride the wave — post a
        follow-up Thread / Story / response while it's hot.
      </div>
      <div className="space-y-2">
        {posts.map((p) => (
          <a
            key={p.postId}
            href={p.platformUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5 hover:border-orange-500 transition-colors"
          >
            <div className="h-12 w-12 rounded-lg overflow-hidden bg-[var(--surface-2)] shrink-0">
              {p.thumbnailUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={p.thumbnailUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : p.platform === "instagram" ? (
                <Camera className="h-full w-full p-3 text-[var(--fg-subtle)]" />
              ) : (
                <Msg className="h-full w-full p-3 text-[var(--fg-subtle)]" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-[var(--fg-muted)] uppercase tracking-wider">
                {p.platform} · {p.type.replace(/^ig_|^threads_/, "")}
              </div>
              <div className="text-sm line-clamp-1">
                {p.caption?.trim() || "(no caption)"}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-base font-bold text-orange-500">
                {p.multiple}×
              </div>
              <div className="text-[10px] text-[var(--fg-subtle)]">
                {p.engagement.toLocaleString()} / {p.baseline.toLocaleString()}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
