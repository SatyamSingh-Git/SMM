"use client";

import { Camera, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = { platform: "instagram" | "threads"; size?: "sm" | "md" };

export function PlatformBadge({ platform, size = "md" }: Props) {
  const Icon = platform === "instagram" ? Camera : MessageCircle;
  const isIg = platform === "instagram";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
        isIg
          ? "bg-[var(--accent-soft)] text-[var(--instagram)]"
          : "bg-[var(--surface-2)] text-[var(--threads)] border border-[var(--border)]"
      )}
    >
      <Icon className={cn(size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")} />
      {platform === "instagram" ? "Instagram" : "Threads"}
    </span>
  );
}
