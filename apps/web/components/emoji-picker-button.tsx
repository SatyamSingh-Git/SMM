"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Smile } from "lucide-react";
import { cn } from "@/lib/utils";

// Lazy-load emoji-picker-react — it ships ~140KB of emoji data we only need
// when the picker opens. Avoids blocking the initial dashboard render.
const Picker = dynamic(() => import("emoji-picker-react"), {
  ssr: false,
  loading: () => (
    <div className="grid h-[360px] w-[320px] place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--fg-muted)]">
      loading emojis…
    </div>
  ),
});

type Props = {
  onPick: (emoji: string) => void;
  className?: string;
  // Where the popover should open relative to the trigger button.
  align?: "left" | "right";
};

export function EmojiPickerButton({ onPick, className, align = "right" }: Props) {
  const [open, setOpen] = React.useState(false);
  const [theme, setTheme] = React.useState<"light" | "dark">("light");
  const rootRef = React.useRef<HTMLDivElement>(null);

  // Detect dark mode via the .dark class our theme toggle sets on <html>.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () =>
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  // Close on outside click + Esc.
  React.useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)}>
      <button
        type="button"
        onClick={() => setOpen((b) => !b)}
        aria-label="Insert emoji"
        title="Insert emoji"
        className={cn(
          "grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] transition-colors",
          "hover:text-[var(--accent)] hover:border-[var(--accent)]",
          open && "border-[var(--accent)] text-[var(--accent)]"
        )}
      >
        <Smile className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className={cn(
            "absolute top-9 z-50 overflow-hidden rounded-xl border border-[var(--border)] shadow-lg",
            align === "right" ? "right-0" : "left-0"
          )}
          // Stop blur/focus bubbling so caret position is preserved.
          onMouseDown={(e) => e.preventDefault()}
        >
          <Picker
            onEmojiClick={(emoji) => {
              onPick(emoji.emoji);
              // Keep open so multi-emoji insertion is easy. User clicks outside / Esc to close.
            }}
            theme={theme === "dark" ? ("dark" as never) : ("light" as never)}
            width={320}
            height={400}
            searchPlaceHolder="Search emoji…"
            previewConfig={{ showPreview: false }}
            skinTonesDisabled={false}
            lazyLoadEmojis
          />
        </div>
      )}
    </div>
  );
}
