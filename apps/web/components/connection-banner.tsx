"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

type Props = {
  // Pass error objects from useQuery() hooks — only shows if at least one is set.
  errors: Array<unknown>;
};

export function ConnectionBanner({ errors }: Props) {
  const qc = useQueryClient();
  const firstError = errors.find((e) => e instanceof Error) as Error | undefined;
  if (!firstError) return null;

  const isNetwork =
    firstError.message.includes("Failed to fetch") ||
    firstError.message.includes("NetworkError") ||
    firstError.message.includes("ECONNREFUSED");

  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-[var(--danger)]/30 bg-[var(--danger)]/8 p-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-[var(--danger)]">
          {isNetwork
            ? "Can't reach the API"
            : "Something failed loading from the API"}
        </div>
        <div className="mt-0.5 truncate text-xs text-[var(--fg-muted)]">
          {isNetwork
            ? "Is the dev server running? Try `pnpm dev` from the repo root."
            : firstError.message}
        </div>
      </div>
      <button
        type="button"
        onClick={() => qc.invalidateQueries()}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs hover:bg-[var(--surface-2)]"
      >
        <RefreshCw className="h-3.5 w-3.5" /> Retry
      </button>
    </div>
  );
}
