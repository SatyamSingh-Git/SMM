"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, KeyRound, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";

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
        <TokenHealthChip />
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

const DAY = 24 * 60 * 60 * 1000;

// Token health: silent when healthy, warns (amber <14d, red <7d or on a refresh
// error) before publishing breaks. One manual-refresh button (5-min server
// cooldown). This is the only place a silent token-refresh failure surfaces.
function TokenHealthChip() {
  const qc = useQueryClient();
  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: api.listAccounts,
    refetchOnWindowFocus: true,
    staleTime: 5 * 60_000,
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: (accountId: string) => api.refreshToken(accountId),
    onSuccess: () => {
      setMsg(null);
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (e) => setMsg((e as Error).message),
  });

  const accounts = accountsQ.data ?? [];
  const worst = pickWorst(accounts);
  if (!worst) return null; // healthy → stay silent

  const isRed = worst.severity === "red";
  return (
    <div
      className={cn(
        "hidden md:inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        isRed
          ? "bg-[var(--danger)]/12 text-[var(--danger)]"
          : "bg-amber-500/15 text-amber-600"
      )}
      title={worst.detail}
    >
      <KeyRound className="h-3.5 w-3.5" />
      {msg ?? worst.label}
      <button
        type="button"
        onClick={() => refresh.mutate(worst.accountId)}
        disabled={refresh.isPending}
        className="ml-0.5 underline decoration-dotted hover:opacity-80"
      >
        {refresh.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "refresh"}
      </button>
    </div>
  );
}

type WorstToken = {
  accountId: string;
  severity: "red" | "amber";
  rank: number;
  label: string;
  detail: string;
};

function pickWorst(accounts: Account[]):
  | { accountId: string; severity: "red" | "amber"; label: string; detail: string }
  | null {
  let best: WorstToken | null = null;
  const now = Date.now();
  for (const a of accounts) {
    let cand: WorstToken | null = null;
    if (a.lastRefreshError) {
      cand = {
        accountId: a.id,
        severity: "red",
        rank: 3,
        label: `${a.platform} token refresh failing`,
        detail: a.lastRefreshError,
      };
    } else if (a.tokenExpiresAt) {
      const daysLeft = Math.floor((new Date(a.tokenExpiresAt).getTime() - now) / DAY);
      if (daysLeft < 7) {
        cand = {
          accountId: a.id,
          severity: "red",
          rank: 2,
          label: `${a.platform} token expires in ${daysLeft}d`,
          detail: `Expires ${new Date(a.tokenExpiresAt).toLocaleDateString()}`,
        };
      } else if (daysLeft < 14) {
        cand = {
          accountId: a.id,
          severity: "amber",
          rank: 1,
          label: `${a.platform} token expires in ${daysLeft}d`,
          detail: `Expires ${new Date(a.tokenExpiresAt).toLocaleDateString()}`,
        };
      }
    }
    if (cand && (!best || cand.rank > best.rank)) best = cand;
  }
  if (!best) return null;
  return {
    accountId: best.accountId,
    severity: best.severity,
    label: best.label,
    detail: best.detail,
  };
}
