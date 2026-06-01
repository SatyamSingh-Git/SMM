"use client";

import { Bell, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

type Props = {
  onCompose: () => void;
  username?: string | null;
  killSwitch?: boolean;
};

export function Topbar({ onCompose, username, killSwitch }: Props) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur px-4 lg:px-6">
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--fg-subtle)]" />
        <Input
          placeholder="Search posts, drafts, captions…"
          className="pl-9"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {killSwitch && (
          <span className="hidden md:inline-flex items-center gap-1.5 rounded-full bg-[var(--danger)]/12 px-2.5 py-1 text-xs font-medium text-[var(--danger)]">
            ● Kill switch ON
          </span>
        )}
        <Button variant="ghost" size="icon" aria-label="Notifications">
          <Bell className="h-4 w-4" />
        </Button>
        <ThemeToggle />
        <Button onClick={onCompose} variant="accent" className="hidden sm:inline-flex">
          + Compose
        </Button>
        <div className="ml-1 flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] py-1 pl-1 pr-3">
          <div className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-[var(--accent)] to-amber-400 text-[10px] font-bold text-white">
            {(username ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <span className="text-xs font-medium text-[var(--fg-muted)] hidden md:inline">
            {username ?? "loading…"}
          </span>
        </div>
      </div>
    </header>
  );
}
