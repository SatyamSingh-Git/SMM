"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { ConnectionBanner } from "@/components/connection-banner";
import { PlatformSection } from "@/components/dashboard/platform-section";
import { MomentumCard } from "@/components/dashboard/momentum";
import { CommentThemesCard } from "@/components/dashboard/comment-themes";
import { SuperFansCard } from "@/components/dashboard/super-fans";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export default function DashboardPage() {
  const healthQ = useQuery({ queryKey: ["health"], queryFn: api.health });
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });

  // Manual sync: pulls Meta Insights for all eligible posts + an account
  // snapshot. We auto-refetch every dashboard query after it succeeds.
  const qc = useQueryClient();
  const [lastSync, setLastSync] = React.useState<{
    backfillCreated: number | null;
    postsCaptured: number;
    accountCaptured: number;
    commentsScanned: number | null;
    aiRefreshed: number | null;
    errors: number;
    at: number;
  } | null>(null);
  const sync = useMutation({
    mutationFn: (opts?: { backfill?: boolean }) => api.dashboardSyncNow(opts),
    onSuccess: (r) => {
      const created =
        r.backfill !== null
          ? r.backfill.threadsCreated + r.backfill.instagramCreated
          : null;
      const aiRefreshed = r.ai ? r.ai.filter((a) => a.ok).length : null;
      setLastSync({
        backfillCreated: created,
        postsCaptured: r.post.captured,
        accountCaptured: r.account.captured,
        commentsScanned: r.comments ? r.comments.scanned : null,
        aiRefreshed,
        errors: r.post.errors + r.account.errors,
        at: Date.now(),
      });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const accounts = accountsQ.data ?? [];

  return (
    <div className="flex min-h-screen">
      <Sidebar onCompose={() => null} activeRoute="dashboard" />

      <div className="flex flex-1 flex-col min-w-0">
        <Topbar
          onCompose={() => null}
          username={accounts[0]?.username ?? null}
          killSwitch={healthQ.data?.killSwitch}
        />

        <main className="flex-1 min-w-0 p-4 lg:p-6 space-y-5">
          <ConnectionBanner
            errors={[accountsQ.error, healthQ.error]}
          />

          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
              <p className="mt-1 text-sm text-[var(--fg-muted)]">
                What's working, what's not, what to do next — read by AI on your
                real performance.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => sync.mutate(undefined)}
                  disabled={sync.isPending}
                >
                  {sync.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Sync now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => sync.mutate({ backfill: true })}
                  disabled={sync.isPending}
                  title="Re-pull past 60 days of posts from Meta (use when you've posted manually since last sync)"
                >
                  Force backfill
                </Button>
              </div>
              {sync.isPending && (
                <div className="text-[11px] text-[var(--fg-muted)] text-right">
                  Pulling from Meta + regenerating AI insights… can take ~1 min
                </div>
              )}
              {sync.isError && (
                <div className="text-[11px] text-[var(--danger)] max-w-[260px] text-right">
                  {(sync.error as Error).message}
                </div>
              )}
              {lastSync && (
                <div className="text-[11px] text-[var(--fg-subtle)] text-right space-y-0.5">
                  {lastSync.backfillCreated != null && (
                    <div>
                      Backfilled {lastSync.backfillCreated} past posts
                    </div>
                  )}
                  <div>
                    +{lastSync.postsCaptured} fresh insights, +
                    {lastSync.accountCaptured} acct snapshot
                    {lastSync.errors > 0 ? ` · ${lastSync.errors} errors` : ""}
                  </div>
                  {lastSync.commentsScanned != null && (
                    <div>{lastSync.commentsScanned} comments scanned on Threads</div>
                  )}
                  {lastSync.aiRefreshed != null && (
                    <div>AI insights regenerated ({lastSync.aiRefreshed}/5)</div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Breaking-out posts — only renders when there's actually
              something pulling 2x+ baseline. Otherwise invisible. */}
          <MomentumCard />

          {/* Audience signal layer — Threads-only (comments live on Threads):
              what people are saying + who's loyal. */}
          <div className="grid lg:grid-cols-2 gap-4">
            <CommentThemesCard />
            <SuperFansCard />
          </div>

          {/* Per-platform sections — each has its own AI insights + focus,
              KPIs, top performers, type breakdown, follower trend, engagement
              mix, caption patterns, and heatmap. */}
          <PlatformSection platform="instagram" />
          <PlatformSection platform="threads" />
        </main>
      </div>
    </div>
  );
}
