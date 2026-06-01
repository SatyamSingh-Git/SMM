"use client";

import * as React from "react";
import { format, formatDistanceToNow } from "date-fns";
import { Check, Clock, FileText, X } from "lucide-react";
import { PlatformBadge } from "@/components/platform-badge";
import { PostActions } from "@/components/post-actions";
import { EngagementPanel } from "@/components/engagement-panel";
import type { Post, PostType } from "@/lib/types";

type Props = { posts: Post[]; onEdit?: (post: Post) => void };

const TYPE_LABEL: Record<PostType, string> = {
  ig_feed: "Feed",
  ig_carousel: "Carousel",
  ig_reel: "Reel",
  ig_story: "Story",
  threads_post: "Post",
  threads_reply_chain: "Chain",
};

export function RightRail({ posts, onEdit }: Props) {
  const now = Date.now();

  const drafts = posts
    .filter((p) => p.status === "draft")
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .slice(0, 6);

  const upcoming = posts
    .filter(
      (p) =>
        p.status === "queued" &&
        p.scheduledAt &&
        new Date(p.scheduledAt).getTime() >= now
    )
    .sort(
      (a, b) =>
        new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime()
    )
    .slice(0, 6);

  const recent = posts
    .filter(
      (p) =>
        p.status === "published" ||
        p.status === "failed" ||
        p.status === "cancelled"
    )
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .slice(0, 6);

  return (
    <aside className="hidden xl:flex w-[340px] shrink-0 flex-col gap-4 p-4 lg:p-6">
      {drafts.length > 0 && (
        <Card title="Drafts" count={drafts.length}>
          {drafts.map((p) => (
            <PostRow key={p.id} post={p} onEdit={onEdit}>
              <Meta>
                <FileText className="h-3 w-3" /> {TYPE_LABEL[p.type]}
              </Meta>
            </PostRow>
          ))}
        </Card>
      )}

      <Card title="Upcoming" count={upcoming.length}>
        {upcoming.length === 0 ? (
          <Empty label="Nothing scheduled yet. Compose a post to get started." />
        ) : (
          upcoming.map((p) => (
            <PostRow key={p.id} post={p} onEdit={onEdit}>
              <Meta>
                <Clock className="h-3 w-3" />
                {format(new Date(p.scheduledAt!), "MMM d · h:mm a")}
              </Meta>
            </PostRow>
          ))
        )}
      </Card>

      <EngagementPanel />

      <Card title="Recent" count={recent.length}>
        {recent.length === 0 ? (
          <Empty label="Posts will appear here once they go live." />
        ) : (
          recent.map((p) => (
            <PostRow key={p.id} post={p} onEdit={onEdit}>
              <Meta>
                <StatusDot status={p.status} />
                {formatDistanceToNow(new Date(p.updatedAt), {
                  addSuffix: true,
                })}
              </Meta>
            </PostRow>
          ))
        )}
      </Card>
    </aside>
  );
}

function PostRow({
  post,
  onEdit,
  children,
}: {
  post: Post;
  onEdit?: (post: Post) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--border-soft)] hover:bg-[var(--surface-2)]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2">
            <PlatformBadge platform={post.platform} size="sm" />
            <span className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--fg-muted)]">
              {TYPE_LABEL[post.type]}
            </span>
          </div>
          <div className="text-[11px] text-[var(--fg-muted)] flex items-center gap-1.5 min-w-0">
            {children}
          </div>
        </div>
        <PostActions post={post} onEdit={onEdit} />
      </div>

      <div className="line-clamp-2 text-sm text-fg">
        {post.caption?.trim() || (
          <span className="text-[var(--fg-subtle)] italic">No caption</span>
        )}
      </div>

      {post.status === "failed" && post.lastError && (
        <div className="rounded-md bg-[var(--danger)]/8 px-2 py-1 text-[11px] text-[var(--danger)] line-clamp-2">
          {post.lastError}
        </div>
      )}
    </div>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 truncate">
      {children}
    </span>
  );
}

function StatusDot({ status }: { status: Post["status"] }) {
  if (status === "published") return <Check className="h-3 w-3 text-[var(--success)]" />;
  if (status === "failed") return <X className="h-3 w-3 text-[var(--danger)]" />;
  if (status === "cancelled") return <X className="h-3 w-3 text-[var(--fg-subtle)]" />;
  return <Clock className="h-3 w-3" />;
}

function Card({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {count !== undefined && (
          <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--fg-muted)] border border-[var(--border)]">
            {count}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] bg-transparent p-4 text-center text-xs text-[var(--fg-muted)]">
      {label}
    </div>
  );
}
