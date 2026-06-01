"use client";

import { cn } from "@/lib/utils";

type Props = { data?: number[][]; loading?: boolean };

// 7x24 grid of avg engagement by (day-of-week IST, hour-of-day IST).
// Darker cells = higher engagement. Best for spotting "post at this time" patterns.
export function PostingHeatmap({ data, loading }: Props) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, i) => i);

  const max = data
    ? Math.max(1, ...data.flat())
    : 1;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight">Best time to post</h3>
        <span className="text-[11px] text-[var(--fg-subtle)]">
          avg engagement, IST · last 60d
        </span>
      </div>
      {loading && !data ? (
        <div className="text-xs text-[var(--fg-muted)]">Loading…</div>
      ) : !data ? (
        <div className="text-xs text-[var(--fg-muted)]">No data yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-[10px]">
            <thead>
              <tr>
                <th className="px-1 py-1"></th>
                {hours.map((h) => (
                  <th
                    key={h}
                    className="px-1 py-1 text-[var(--fg-subtle)] font-normal"
                  >
                    {h % 6 === 0 ? `${h}` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, d) => (
                <tr key={d}>
                  <td className="px-2 py-0.5 text-[var(--fg-muted)] text-right">
                    {days[d]}
                  </td>
                  {row.map((v, h) => {
                    const intensity = Math.min(1, v / max);
                    return (
                      <td key={h} className="p-0.5">
                        <div
                          className={cn(
                            "h-5 w-5 rounded-[3px] border border-[var(--border-soft)]",
                            v === 0 && "bg-[var(--surface-2)]"
                          )}
                          style={
                            v > 0
                              ? {
                                  background: `color-mix(in oklab, var(--accent) ${Math.round(
                                    intensity * 80
                                  )}%, var(--surface-2))`,
                                }
                              : undefined
                          }
                          title={`${days[d]} ${h}:00 — avg ${v}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex items-center gap-2 text-[10px] text-[var(--fg-subtle)]">
            <span>Less</span>
            {[0.1, 0.3, 0.55, 0.8, 1].map((i) => (
              <div
                key={i}
                className="h-3 w-5 rounded-[3px] border border-[var(--border-soft)]"
                style={{
                  background: `color-mix(in oklab, var(--accent) ${Math.round(
                    i * 80
                  )}%, var(--surface-2))`,
                }}
              />
            ))}
            <span>More</span>
          </div>
        </div>
      )}
    </div>
  );
}
