"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  Loader2,
  MessageSquare,
  Moon,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import type { EngagementComment, EngagementStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const DAILY_REPLY_CAP = 300;

// Right-rail panel showing incoming Threads comments + what the agent
// has done (replied / queued / failed) with manual override buttons.

const STATUS_TABS: Array<{ id: EngagementStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "queued", label: "Queued" },
  { id: "replied", label: "Replied" },
  { id: "failed", label: "Failed" },
];

export function EngagementPanel() {
  const qc = useQueryClient();
  const [tab, setTab] = React.useState<(typeof STATUS_TABS)[number]["id"]>("all");

  const statsQ = useQuery({
    queryKey: ["engagement", "stats"],
    queryFn: api.engagementStats,
    refetchInterval: 30_000,
  });

  const commentsQ = useQuery({
    queryKey: ["engagement", "comments", tab],
    queryFn: () =>
      api.listEngagementComments(
        tab === "all" ? { limit: 30 } : { status: tab, limit: 30 }
      ),
    refetchInterval: 15_000,
  });

  const pollNow = useMutation({
    mutationFn: api.pollEngagementNow,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["engagement"] }),
  });

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="text-sm font-semibold tracking-tight">Auto-replies</h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => pollNow.mutate()}
            disabled={pollNow.isPending}
            title="Poll Threads for new comments now"
            className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-50"
          >
            {pollNow.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Stats row: style library size + today's reply count toward the cap. */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <StatTile
          label="Style learned"
          value={statsQ.data?.styleExamples ?? 0}
          hint="past replies (auto-refreshed every 12h)"
        />
        <StatTile
          label="Replies today"
          value={`${statsQ.data?.repliesToday ?? 0}/${DAILY_REPLY_CAP}`}
          hint="hard daily cap"
          warn={(statsQ.data?.repliesToday ?? 0) >= DAILY_REPLY_CAP}
        />
      </div>

      <SleepScheduleCard />


      {/* Status filter tabs */}
      <div className="mb-3 flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
        {STATUS_TABS.map((t) => {
          const count =
            t.id === "all"
              ? Object.values(statsQ.data?.counts ?? {}).reduce(
                  (a, b) => a + b,
                  0
                )
              : statsQ.data?.counts?.[t.id] ?? 0;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                tab === t.id
                  ? "bg-[var(--surface)] text-fg shadow-sm"
                  : "text-[var(--fg-muted)] hover:text-fg"
              )}
            >
              {t.label}
              <span className="ml-1 text-[10px] text-[var(--fg-subtle)]">
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Comment list */}
      <div className="flex flex-col gap-2">
        {commentsQ.isLoading ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--fg-muted)]">
            Loading…
          </div>
        ) : (commentsQ.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--fg-muted)]">
            No comments yet. Run the poller or wait — it checks Threads every
            5 min automatically.
          </div>
        ) : (
          (commentsQ.data ?? []).map((c) => <CommentRow key={c.id} comment={c} />)
        )}
      </div>
    </div>
  );
}

function CommentRow({ comment }: { comment: EngagementComment }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = React.useState(false);
  // Cache of the preview reply for this card — only fetched on first expand.
  const [preview, setPreview] = React.useState<{
    shouldReply: boolean;
    reply: string | null;
    reason: string | null;
  } | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const cancel = useMutation({
    mutationFn: () => api.cancelEngagement(comment.id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["engagement"] }),
  });
  const retry = useMutation({
    mutationFn: () => api.retryEngagement(comment.id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["engagement"] }),
  });
  const previewMutation = useMutation({
    mutationFn: () => api.previewEngagementReply(comment.id),
    onSuccess: (data) => {
      setPreview(data);
      setPreviewError(null);
    },
    onError: (err) => setPreviewError((err as Error).message),
  });

  // Only queued/new comments benefit from a preview (no actual reply yet).
  // Replied / skipped / failed cards already show their text inline.
  const canPreview = comment.status === "queued" || comment.status === "new";

  function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && canPreview && !preview && !previewMutation.isPending) {
      previewMutation.mutate();
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge status={comment.status} />
          <span className="truncate text-[11px] text-[var(--fg-muted)]">
            @{comment.authorUsername ?? "user"}
          </span>
        </div>
        <div className="flex flex-col items-end leading-tight text-[11px] text-[var(--fg-subtle)] shrink-0">
          <span>
            posted{" "}
            {formatDistanceToNow(new Date(comment.receivedAt), { addSuffix: true })}
          </span>
          {comment.status === "replied" && (
            <span className="text-[var(--success)]">
              replied{" "}
              {formatDistanceToNow(new Date(comment.updatedAt), { addSuffix: true })}
            </span>
          )}
        </div>
      </div>

      <div className="text-sm leading-snug">{comment.text}</div>

      {comment.postCaption && (
        <div className="text-[11px] text-[var(--fg-subtle)] line-clamp-1">
          on: &ldquo;{comment.postCaption}&rdquo;
        </div>
      )}

      {/* Replied: show the actual reply */}
      {comment.agentReplyText && (
        <div className="mt-1 rounded-md bg-[var(--accent-soft)] p-2">
          <div className="text-[10px] uppercase tracking-wider text-[var(--accent)] flex items-center gap-1">
            <Bot className="h-3 w-3" /> Agent reply
          </div>
          <div className="mt-0.5 text-sm leading-snug">
            {comment.agentReplyText}
          </div>
        </div>
      )}

      {/* Skipped: show the reason */}
      {comment.status === "skipped" && comment.lastError && (
        <div className="mt-1 rounded-md bg-[var(--surface-2)] p-2 text-[11px] text-[var(--fg-muted)]">
          <span className="font-medium">Skipped:</span> {comment.lastError}
        </div>
      )}

      {/* Failed: error */}
      {comment.status === "failed" && comment.lastError && (
        <div className="rounded-md bg-[var(--danger)]/10 px-2 py-1 text-[11px] text-[var(--danger)] line-clamp-2">
          {comment.lastError}
        </div>
      )}

      {/* Expand drawer — only meaningful for queued items where we can preview */}
      {canPreview && expanded && (
        <div className="mt-1 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-soft)]/40 p-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-[var(--accent)] flex items-center gap-1">
              <Eye className="h-3 w-3" /> Preview reply
            </div>
            <button
              type="button"
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
              className="text-[10px] text-[var(--accent)] hover:underline disabled:opacity-50"
              title="Regenerate preview"
            >
              {previewMutation.isPending ? "…" : "↻ refresh"}
            </button>
          </div>
          {previewMutation.isPending && !preview && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--fg-muted)]">
              <Loader2 className="h-3 w-3 animate-spin" /> Generating…
            </div>
          )}
          {preview && preview.shouldReply && preview.reply && (
            <>
              <div className="mt-0.5 text-sm leading-snug">{preview.reply}</div>
              <div className="mt-1 text-[10px] text-[var(--fg-subtle)] italic">
                Preview only — actual reply may differ slightly when it fires
                (style examples update over time).
              </div>
            </>
          )}
          {preview && !preview.shouldReply && (
            <div className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
              <span className="font-medium">Would skip:</span>{" "}
              {preview.reason ?? "(no reason)"}
            </div>
          )}
          {previewError && (
            <div className="mt-1 text-[11px] text-[var(--danger)]">
              {previewError}
            </div>
          )}
        </div>
      )}

      {/* Action row: expand toggle (left) + manual buttons (right) */}
      {(canPreview ||
        comment.status === "failed") && (
        <div className="mt-1 flex items-center justify-between">
          {canPreview ? (
            <button
              type="button"
              onClick={toggleExpand}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)]"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" /> Hide preview
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" /> Preview reply
                </>
              )}
            </button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-1">
            {(comment.status === "new" || comment.status === "queued") && (
              <button
                type="button"
                onClick={() => {
                  if (confirm("Skip this comment? You'll reply yourself.")) {
                    cancel.mutate();
                  }
                }}
                disabled={cancel.isPending}
                className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] hover:text-[var(--danger)] hover:border-[var(--danger)] disabled:opacity-50"
                title="Skip — reply manually"
              >
                {cancel.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {comment.status === "failed" && (
              <button
                type="button"
                onClick={() => retry.mutate()}
                disabled={retry.isPending}
                className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-50"
                title="Retry"
              >
                {retry.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string | number;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-[var(--surface)] p-3",
        warn
          ? "border-[var(--danger)]/40 bg-[var(--danger)]/8"
          : "border-[var(--border)]"
      )}
    >
      <div className="text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-base font-semibold",
          warn && "text-[var(--danger)]"
        )}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-[var(--fg-subtle)] mt-0.5">{hint}</div>
      )}
    </div>
  );
}

// Compact card showing the fixed quiet windows + today's randomized dynamic
// sleep windows. Lets the user verify the runner is pausing at the times
// they expect. The windows are deterministic from the IST date — same date,
// same windows, every fetch.
function SleepScheduleCard() {
  const [open, setOpen] = React.useState(false);
  const q = useQuery({
    queryKey: ["engagement", "sleep-windows"],
    queryFn: api.engagementSleepWindows,
    // Re-fetch every 5 min so the "now" indicator stays roughly fresh and the
    // windows refresh after IST midnight without a manual reload.
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
  });

  const d = q.data;
  const nowMin = d ? hmToMinutes(d.nowIst) : 0;
  const inWindow =
    d &&
    [...d.fixedQuietWindows, ...d.dynamicSleepWindows].some((w) => {
      const s = hmToMinutes(w.start);
      const e = hmToMinutes(w.end);
      return nowMin >= s && nowMin < e;
    });

  return (
    <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[var(--surface-2)]"
      >
        <div className="flex items-center gap-1.5">
          <Moon className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--fg-muted)]">
            Sleep schedule today (IST)
          </span>
          {d && (
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                inWindow
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "bg-[var(--success)]/15 text-[var(--success)]"
              )}
              title={`Now: ${d.nowIst} IST`}
            >
              {inWindow ? "paused" : "active"} · {d.nowIst}
            </span>
          )}
        </div>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-[var(--fg-muted)]" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--fg-muted)]" />
        )}
      </button>

      {open && (
        <div className="border-t border-[var(--border)] p-3 space-y-3">
          {q.isLoading && <div className="text-[11px] text-[var(--fg-muted)]">Loading…</div>}
          {q.error && (
            <div className="text-[11px] text-[var(--danger)]">
              Couldn&apos;t load sleep schedule — endpoint may not be deployed yet.
            </div>
          )}
          {d && (
            <>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--fg-muted)] mb-1">
                  Fixed quiet windows (always)
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {d.fixedQuietWindows.map((w) => (
                    <WindowChip
                      key={w.start}
                      start={w.start}
                      end={w.end}
                      label={w.label}
                      nowMin={nowMin}
                      tone="muted"
                    />
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--fg-muted)] mb-1">
                  Random sleeps today ({d.dynamicSleepWindows.length}) · seeded
                  from {d.dateKey}
                </div>
                {d.dynamicSleepWindows.length === 0 ? (
                  <div className="text-[11px] text-[var(--fg-muted)]">
                    No dynamic sleeps for today (config issue?).
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-1.5">
                    {d.dynamicSleepWindows.map((w, i) => (
                      <WindowChip
                        key={i}
                        start={w.start}
                        end={w.end}
                        nowMin={nowMin}
                        tone="accent"
                      />
                    ))}
                  </div>
                )}
                <div className="mt-1.5 text-[10px] text-[var(--fg-subtle)] leading-relaxed">
                  Computed deterministically from the IST date — same date
                  always produces the same windows, on any process. Resets at
                  IST midnight.
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function WindowChip({
  start,
  end,
  label,
  nowMin,
  tone,
}: {
  start: string;
  end: string;
  label?: string;
  nowMin: number;
  tone: "muted" | "accent";
}) {
  const sMin = hmToMinutes(start);
  const eMin = hmToMinutes(end);
  const isNow = nowMin >= sMin && nowMin < eMin;
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1 text-center",
        isNow
          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
          : tone === "accent"
            ? "border-[var(--border)] bg-[var(--surface-2)]"
            : "border-[var(--border)] bg-[var(--surface-2)]/50"
      )}
      title={label}
    >
      <div className="text-[11px] font-mono font-semibold">
        {start}–{end}
      </div>
      {label && (
        <div className="text-[9px] text-[var(--fg-subtle)] uppercase tracking-wider">
          {label}
        </div>
      )}
      {isNow && (
        <div className="text-[9px] text-[var(--accent)] uppercase tracking-wider font-medium">
          now
        </div>
      )}
    </div>
  );
}

function hmToMinutes(hm: string): number {
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
}

function StatusBadge({ status }: { status: EngagementStatus }) {
  const config: Record<
    EngagementStatus,
    { icon: React.ComponentType<{ className?: string }>; label: string; cls: string }
  > = {
    new: { icon: MessageSquare, label: "New", cls: "text-[var(--fg-muted)]" },
    queued: { icon: Clock, label: "Queued", cls: "text-[var(--accent)]" },
    replying: {
      icon: Loader2,
      label: "Replying",
      cls: "text-[var(--accent)] animate-spin",
    },
    replied: { icon: Check, label: "Replied", cls: "text-[var(--success)]" },
    skipped: { icon: X, label: "Skipped", cls: "text-[var(--fg-subtle)]" },
    failed: { icon: AlertTriangle, label: "Failed", cls: "text-[var(--danger)]" },
  };
  const c = config[status];
  const Icon = c.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", c.cls)}>
      <Icon className={cn("h-3 w-3", status === "replying" && "animate-spin")} />
      {c.label}
    </span>
  );
}
