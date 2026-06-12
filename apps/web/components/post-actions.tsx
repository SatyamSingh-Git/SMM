"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Loader2,
  Pencil,
  Repeat2,
  RotateCw,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Post } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  post: Post;
  size?: "sm" | "md";
  onEdit?: (post: Post) => void;
};

// Compact icon-only action row that adapts to the post's status.
// - draft     -> [Send (publish now)] [Trash]
// - queued    -> [Send (publish now)] [Trash (cancel)]
// - failed    -> [Retry]              [Trash]
// - published -> [View on platform]
// - cancelled -> [Retry]
export function PostActions({ post, size = "sm", onEdit }: Props) {
  const qc = useQueryClient();

  const publishNow = useMutation({
    mutationFn: () => api.publishNow(post.id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["posts"] }),
  });
  const retry = useMutation({
    mutationFn: () => api.retryPost(post.id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["posts"] }),
  });
  const [undoFor, setUndoFor] = React.useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: () => api.cancelPost(post.id),
    onSuccess: () => {
      // Offer an undo for a few seconds (reuses the soft-delete → restore path).
      setUndoFor(post.id);
      setTimeout(() => setUndoFor((v) => (v === post.id ? null : v)), 8000);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["posts"] }),
  });
  const restore = useMutation({
    mutationFn: () => api.restorePost(post.id),
    onSuccess: () => setUndoFor(null),
    onSettled: () => qc.invalidateQueries({ queryKey: ["posts"] }),
  });
  const [dupMsg, setDupMsg] = React.useState<string | null>(null);
  const duplicate = useMutation({
    mutationFn: () => api.duplicatePost(post.id),
    onSuccess: (out) => {
      setDupMsg(`→ ${out.targetPlatform} draft created`);
      setTimeout(() => setDupMsg(null), 6000);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["posts"] }),
  });
  const otherPlatform = post.platform === "instagram" ? "Threads" : "Instagram";

  const busy =
    publishNow.isPending ||
    retry.isPending ||
    cancel.isPending ||
    restore.isPending ||
    duplicate.isPending;
  const err =
    (publishNow.error as Error | null)?.message ||
    (retry.error as Error | null)?.message ||
    (cancel.error as Error | null)?.message ||
    null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {post.status === "published" && post.platformUrl && (
          <a
            href={post.platformUrl}
            target="_blank"
            rel="noreferrer"
            title="Open on platform"
            className={iconBtn(size)}
          >
            <ExternalLink className={iconCls(size)} />
          </a>
        )}

        {onEdit && post.status !== "published" && post.status !== "publishing" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onEdit(post)}
            title="Edit"
            className={iconBtn(size)}
          >
            <Pencil className={iconCls(size)} />
          </button>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => duplicate.mutate()}
          title={`Duplicate to ${otherPlatform} (new draft)`}
          className={iconBtn(size)}
        >
          {duplicate.isPending ? (
            <Loader2 className={cn(iconCls(size), "animate-spin")} />
          ) : (
            <Repeat2 className={iconCls(size)} />
          )}
        </button>

        {(post.status === "draft" || post.status === "queued") && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!confirm("Publish this post right now?")) return;
              publishNow.mutate();
            }}
            title="Publish now"
            className={iconBtn(size)}
          >
            {publishNow.isPending ? (
              <Loader2 className={cn(iconCls(size), "animate-spin")} />
            ) : (
              <Send className={iconCls(size)} />
            )}
          </button>
        )}

        {(post.status === "failed" || post.status === "cancelled") && (
          <button
            type="button"
            disabled={busy}
            onClick={() => retry.mutate()}
            title="Retry"
            className={iconBtn(size, "accent")}
          >
            {retry.isPending ? (
              <Loader2 className={cn(iconCls(size), "animate-spin")} />
            ) : (
              <RotateCw className={iconCls(size)} />
            )}
          </button>
        )}

        {post.status !== "published" && post.status !== "cancelled" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!confirm("Cancel / delete this post?")) return;
              cancel.mutate();
            }}
            title={post.status === "queued" ? "Cancel scheduled post" : "Delete"}
            className={iconBtn(size, "danger")}
          >
            {cancel.isPending ? (
              <Loader2 className={cn(iconCls(size), "animate-spin")} />
            ) : (
              <Trash2 className={iconCls(size)} />
            )}
          </button>
        )}
      </div>
      {undoFor === post.id && (
        <button
          type="button"
          onClick={() => restore.mutate()}
          disabled={restore.isPending}
          className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
        >
          {restore.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Undo2 className="h-3 w-3" />
          )}
          Undo
        </button>
      )}
      {dupMsg && (
        <div className="text-[10px] text-[var(--accent)]">{dupMsg}</div>
      )}
      {err && (
        <div className="text-[10px] text-[var(--danger)] max-w-[180px] truncate" title={err}>
          {err}
        </div>
      )}
    </div>
  );
}

function iconBtn(size: "sm" | "md", tone?: "accent" | "danger") {
  return cn(
    "grid place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50 disabled:pointer-events-none",
    size === "sm" ? "h-7 w-7" : "h-8 w-8",
    tone === "accent" && "hover:border-[var(--accent)] hover:text-[var(--accent)]",
    tone === "danger" && "hover:border-[var(--danger)] hover:text-[var(--danger)]"
  );
}

function iconCls(size: "sm" | "md") {
  return size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
}
