"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Heart, Loader2, MessageSquare } from "lucide-react";
import { api } from "@/lib/api";

export function SuperFansCard() {
  const q = useQuery({
    queryKey: ["dashboard", "super-fans"],
    queryFn: api.dashboardSuperFans,
    refetchOnWindowFocus: false,
    staleTime: 10 * 60_000,
  });
  const fans = q.data ?? [];

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Heart className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="text-sm font-semibold tracking-tight">Super-fans</h3>
        </div>
        <span className="text-[10px] text-[var(--fg-subtle)]">last 30 days</span>
      </div>

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)] py-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : fans.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--fg-muted)]">
          No repeat commenters yet. Once your comments start rolling in, your
          super-fans will surface here.
        </div>
      ) : (
        <>
          <div className="mb-2 text-[11px] text-[var(--fg-muted)]">
            These accounts comment most often — DM them, reply manually, feature
            them. Warm leads.
          </div>
          <div className="space-y-1.5">
            {fans.map((f) => (
              <div
                key={(f.authorPlatformId ?? f.authorUsername ?? "?") + f.lastCommentAt}
                className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5"
              >
                <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[var(--accent)] to-amber-400 text-[11px] font-bold text-white shrink-0">
                  {(f.authorUsername ?? "?").slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm truncate">
                      @{f.authorUsername ?? "unknown"}
                    </span>
                    {f.authorUsername && (
                      <a
                        href={`https://www.threads.net/@${f.authorUsername}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--fg-subtle)] hover:text-[var(--accent)]"
                        title="Open profile"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <div className="text-[11px] text-[var(--fg-subtle)] truncate italic">
                    &ldquo;{f.lastCommentText}&rdquo;
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="inline-flex items-center gap-1 text-xs font-semibold">
                    <MessageSquare className="h-3 w-3 text-[var(--accent)]" />
                    {f.commentCount}
                  </div>
                  <div className="text-[10px] text-[var(--fg-subtle)]">
                    on {f.postsEngagedOn} post{f.postsEngagedOn === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
