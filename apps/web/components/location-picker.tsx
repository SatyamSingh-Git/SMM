"use client";

import * as React from "react";
import { MapPin, Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Loc = {
  id: string;
  name: string;
  location?: { city?: string; country?: string; state?: string };
};

type Props = {
  accountId: string;
  value: { id: string; name: string } | null;
  onChange: (loc: { id: string; name: string } | null) => void;
};

export function LocationPicker({ accountId, value, onChange }: Props) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<Loc[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const debounceRef = React.useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2 || value) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const out = await api.searchLocations(accountId, q);
        setResults(out.results);
        setOpen(true);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, accountId, value]);

  if (value) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs">
        <MapPin className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="truncate">{value.name}</span>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setQ("");
          }}
          className="text-[var(--fg-subtle)] hover:text-[var(--danger)]"
          aria-label="Remove location"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="relative">
        <MapPin className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--fg-subtle)]" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tag a location… (search 2+ chars)"
          className="pl-8"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-[var(--fg-subtle)]" />
        )}
      </div>
      {open && (q.length >= 2 || error) && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg">
          {error ? (
            <div className="p-3 text-xs text-[var(--danger)]">
              Location search failed: {error}
              <div className="mt-1 text-[10px] text-[var(--fg-subtle)]">
                Some IG Login tokens don&apos;t have permission for pages/search. You
                can still post — just without a location.
              </div>
            </div>
          ) : results.length === 0 && !loading ? (
            <div className="p-3 text-xs text-[var(--fg-subtle)]">
              No matches.
            </div>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange({ id: r.id, name: r.name });
                      setQ("");
                      setOpen(false);
                    }}
                    className={cn(
                      "block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                    )}
                  >
                    <div className="truncate font-medium">{r.name}</div>
                    {r.location && (
                      <div className="truncate text-[11px] text-[var(--fg-subtle)]">
                        {[r.location.city, r.location.state, r.location.country]
                          .filter(Boolean)
                          .join(", ")}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
