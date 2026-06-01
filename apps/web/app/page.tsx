"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { startOfMonth, endOfMonth, subMonths, addMonths } from "date-fns";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { CalendarView } from "@/components/calendar-view";
import { ComposeDialog } from "@/components/compose-dialog";
import { RightRail } from "@/components/right-rail";
import { ConnectionBanner } from "@/components/connection-banner";
import { api } from "@/lib/api";
import type { Post } from "@/lib/types";

export default function Home() {
  const [open, setOpen] = React.useState(false);
  const [selectedDate, setSelectedDate] = React.useState<Date | null>(null);
  const [editingPost, setEditingPost] = React.useState<Post | null>(null);

  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const healthQ = useQuery({ queryKey: ["health"], queryFn: api.health });

  const range = React.useMemo(() => {
    const now = new Date();
    return {
      from: startOfMonth(subMonths(now, 1)).toISOString(),
      to: endOfMonth(addMonths(now, 2)).toISOString(),
    };
  }, []);
  const postsQ = useQuery({
    queryKey: ["posts", range],
    queryFn: () => api.listPosts(range),
    refetchInterval: 15_000,
  });

  const accounts = accountsQ.data ?? [];
  const posts = postsQ.data ?? [];

  function compose(date?: Date | null) {
    setEditingPost(null);
    setSelectedDate(date ?? null);
    setOpen(true);
  }
  function edit(p: Post) {
    setEditingPost(p);
    setSelectedDate(null);
    setOpen(true);
  }
  function onSelectPost(p: Post) {
    if (p.status === "published" && p.platformUrl) {
      window.open(p.platformUrl, "_blank");
    } else if (p.status !== "publishing") {
      edit(p);
    }
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar onCompose={() => compose()} />

      <div className="flex flex-1 flex-col min-w-0">
        <Topbar
          onCompose={() => compose()}
          username={accounts[0]?.username ?? null}
          killSwitch={healthQ.data?.killSwitch}
        />

        <div className="flex flex-1">
          <main className="flex-1 min-w-0 p-4 lg:p-6">
            <ConnectionBanner
              errors={[accountsQ.error, healthQ.error, postsQ.error]}
            />

            <PageHeader
              accounts={accounts}
              loadingAccounts={accountsQ.isLoading}
              loadingPosts={postsQ.isLoading}
              total={posts.length}
            />

            <div className="mt-4">
              <CalendarView
                posts={posts}
                onSelectDate={(d) => compose(d)}
                onSelectPost={onSelectPost}
              />
            </div>

            <Legend />
          </main>

          <RightRail posts={posts} onEdit={edit} />
        </div>
      </div>

      <ComposeDialog
        open={open}
        onOpenChange={(b) => {
          setOpen(b);
          if (!b) setEditingPost(null);
        }}
        accounts={accounts}
        defaultDate={selectedDate}
        editingPost={editingPost}
      />
    </div>
  );
}

function PageHeader({
  accounts,
  loadingAccounts,
  loadingPosts,
  total,
}: {
  accounts: { id: string; platform: string; username: string | null }[];
  loadingAccounts: boolean;
  loadingPosts: boolean;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Content Calendar</h1>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          {loadingAccounts
            ? "Loading accounts…"
            : accounts.length === 0
              ? "No accounts connected yet."
              : `Connected: ${accounts
                  .map((a) => `@${a.username ?? "?"} (${a.platform})`)
                  .join(" · ")}`}
        </p>
      </div>
      <div className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
        {loadingPosts ? <span>Loading posts…</span> : <span>{total} post{total === 1 ? "" : "s"} in view</span>}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--fg-muted)]">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-[var(--instagram)]" />
        Instagram
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-[var(--threads)]" />
        Threads
      </div>
      <span className="text-[var(--fg-subtle)]">|</span>
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-[var(--success)]" />
        Published
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-[var(--danger)]" />
        Failed
      </div>
      <div className="ml-auto">
        Click a date to compose · click a post to open on the platform
      </div>
    </div>
  );
}
