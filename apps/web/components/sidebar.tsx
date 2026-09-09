"use client";

import Link from "next/link";
import { Calendar, Camera, LayoutDashboard, Plus, Settings, Sparkles, UserCog, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Route = "calendar" | "dashboard" | "inspire" | "prompts" | "profile" | "settings";
type Props = { onCompose: () => void; activeRoute?: Route };

export function Sidebar({ onCompose, activeRoute = "calendar" }: Props) {
  const items: Array<{
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    href?: string;
    route?: Route;
    soon?: boolean;
  }> = [
    { icon: Calendar, label: "Content Calendar", href: "/", route: "calendar" },
    {
      icon: LayoutDashboard,
      label: "Dashboard",
      href: "/dashboard",
      route: "dashboard",
    },
    {
      icon: Wand2,
      label: "What to Write",
      href: "/inspire",
      route: "inspire",
    },
    {
      icon: Camera,
      label: "Image Prompts",
      href: "/prompts",
      route: "prompts",
    },
    { icon: Sparkles, label: "AI Assist", soon: true },
    { icon: UserCog, label: "Persona", href: "/profile", route: "profile" },
    { icon: Settings, label: "Settings", href: "/settings", route: "settings" },
  ];

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] px-4 py-5">
      <div className="flex items-center gap-2 px-2 pb-1">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-fg text-bg font-bold">
          S
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">SMM</div>
          <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">
            Personal Suite
          </div>
        </div>
      </div>

      <Button onClick={onCompose} className="mt-6 w-full" size="lg">
        <Plus className="h-4 w-4" />
        New Post
      </Button>

      <nav className="mt-6 flex flex-col gap-1">
        {items.map(({ icon: Icon, label, href, route, soon }) => {
          const active = !soon && route === activeRoute;
          const content = (
            <span className="flex items-center gap-3">
              <Icon className="h-4 w-4" />
              {label}
            </span>
          );
          const classes = cn(
            "group flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors",
            active
              ? "bg-[var(--surface-2)] text-fg font-medium"
              : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-fg",
            soon &&
              "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-[var(--fg-muted)]"
          );
          if (soon || !href) {
            return (
              <button key={label} disabled={!!soon} className={classes}>
                {content}
                {soon && (
                  <span className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
                    soon
                  </span>
                )}
              </button>
            );
          }
          return (
            <Link key={label} href={href} className={classes}>
              {content}
              {active && (
                <span className="h-5 w-1 rounded-full bg-[var(--accent)]" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs text-[var(--fg-muted)]">
        <div className="mb-1 font-medium text-fg">Stage 1 + 2 · Live</div>
        Auto-reply running. Stage 3 (auto-generate) coming next.
      </div>
    </aside>
  );
}
