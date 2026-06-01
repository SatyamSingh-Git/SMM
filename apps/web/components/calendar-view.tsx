"use client";

import * as React from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventInput } from "@fullcalendar/core";
import { format } from "date-fns";
import { AlertTriangle, Camera, Check, Loader2, MessageCircle } from "lucide-react";
import type { Post } from "@/lib/types";

type Props = {
  posts: Post[];
  onSelectDate: (date: Date) => void;
  onSelectPost: (post: Post) => void;
};

export function CalendarView({ posts, onSelectDate, onSelectPost }: Props) {
  const events: EventInput[] = React.useMemo(
    () =>
      posts
        .filter((p) => p.scheduledAt)
        .map((p) => ({
          id: p.id,
          start: p.scheduledAt!,
          extendedProps: { post: p },
          allDay: false,
          classNames: [`smm-event-${p.status}`],
        })),
    [posts]
  );

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4 shadow-[0_1px_2px_rgba(0,0,0,.02)]">
      <FullCalendar
        plugins={[dayGridPlugin, interactionPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{
          left: "prev,next today",
          center: "title",
          right: "",
        }}
        height="auto"
        firstDay={1}
        dayMaxEvents={3}
        events={events}
        eventDisplay="block"
        eventContent={(arg) => {
          const post = arg.event.extendedProps.post as Post;
          return <CalendarEvent post={post} />;
        }}
        dateClick={(arg) => onSelectDate(arg.date)}
        eventClick={(arg) =>
          onSelectPost(arg.event.extendedProps.post as Post)
        }
      />
    </div>
  );
}

function CalendarEvent({ post }: { post: Post }) {
  const isIg = post.platform === "instagram";
  const PlatformIcon = isIg ? Camera : MessageCircle;
  const StatusIcon =
    post.status === "published"
      ? Check
      : post.status === "failed"
        ? AlertTriangle
        : post.status === "publishing"
          ? Loader2
          : null;
  const accent =
    post.status === "failed"
      ? "var(--danger)"
      : post.status === "published"
        ? "var(--success)"
        : isIg
          ? "var(--instagram)"
          : "var(--threads)";

  return (
    <div className="flex items-center gap-1.5 truncate" style={{ color: accent }}>
      <PlatformIcon className="h-3 w-3 shrink-0" />
      <span className="truncate text-fg/90">
        {format(new Date(post.scheduledAt!), "h:mma").toLowerCase()}
        {post.caption ? ` · ${post.caption.slice(0, 28)}` : ""}
      </span>
      {StatusIcon && (
        <StatusIcon
          className={
            "ml-auto h-3 w-3 shrink-0" +
            (post.status === "publishing" ? " animate-spin" : "")
          }
        />
      )}
    </div>
  );
}
