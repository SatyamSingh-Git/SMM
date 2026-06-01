"use client";

import * as React from "react";
import { AtSign, Eye, Tag, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { EmojiPickerButton } from "./emoji-picker-button";
import { insertAtCursor } from "@/lib/insert-at-cursor";

export type UserTag = { username: string; x: number; y: number };

export type AssetMeta = {
  id: string;
  publicUrl: string;
  mimeType: string;
  altText: string;
  userTags: UserTag[];
};

type Props = {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  asset: AssetMeta | null;
  onChange: (meta: AssetMeta) => void;
};

export function AssetDetailDialog({ open, onOpenChange, asset, onChange }: Props) {
  const [pending, setPending] = React.useState<{ x: number; y: number } | null>(
    null
  );
  const [pendingName, setPendingName] = React.useState("");
  const imgRef = React.useRef<HTMLDivElement>(null);
  const altRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (open) {
      setPending(null);
      setPendingName("");
    }
  }, [open]);

  if (!asset) return null;

  const isVideo = asset.mimeType.startsWith("video/");

  function handleImageClick(e: React.MouseEvent<HTMLDivElement>) {
    if (isVideo || !imgRef.current) return; // Video tagging isn't supported by IG
    const rect = imgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setPending({ x, y });
    setPendingName("");
  }

  function commitPending() {
    if (!asset) return;
    const name = pendingName.trim().replace(/^@/, "");
    if (!name || !pending) {
      setPending(null);
      return;
    }
    onChange({
      ...asset,
      userTags: [...asset.userTags, { username: name, x: pending.x, y: pending.y }],
    });
    setPending(null);
    setPendingName("");
  }

  function removeTag(i: number) {
    if (!asset) return;
    onChange({
      ...asset,
      userTags: asset.userTags.filter((_, idx) => idx !== i),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-[var(--accent)]" />
            Image details
          </DialogTitle>
          <DialogDescription>
            Add alt text for accessibility. {isVideo ? "Videos don't support in-image tagging." : "Click on the image to tag a user."}
          </DialogDescription>
        </DialogHeader>

        <div
          ref={imgRef}
          onClick={handleImageClick}
          className={cn(
            "relative mt-2 overflow-hidden rounded-lg border border-[var(--border)] bg-black select-none",
            !isVideo && "cursor-crosshair"
          )}
        >
          {isVideo ? (
            <video src={asset.publicUrl} className="max-h-[400px] w-full object-contain" controls />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={asset.publicUrl}
              alt={asset.altText || ""}
              draggable={false}
              className="max-h-[400px] w-full object-contain"
            />
          )}

          {/* Existing tags */}
          {!isVideo &&
            asset.userTags.map((t, i) => (
              <div
                key={`${t.username}-${i}`}
                style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }}
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
              >
                <div className="rounded-full border border-white bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white shadow">
                  @{t.username}
                </div>
              </div>
            ))}

          {/* Pending tag (user clicked but hasn't named yet) */}
          {pending && (
            <div
              style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-1 rounded-lg border border-[var(--accent)] bg-[var(--surface)] p-1 shadow-lg">
                <AtSign className="h-3.5 w-3.5 text-[var(--fg-subtle)]" />
                <input
                  autoFocus
                  value={pendingName}
                  onChange={(e) => setPendingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitPending();
                    if (e.key === "Escape") setPending(null);
                  }}
                  placeholder="username"
                  className="w-32 bg-transparent text-xs outline-none placeholder:text-[var(--fg-subtle)]"
                />
                <button
                  type="button"
                  onClick={commitPending}
                  className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-medium text-white"
                >
                  ✓
                </button>
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="text-[var(--fg-subtle)] hover:text-[var(--danger)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Tag list */}
        {asset.userTags.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-[var(--fg-muted)]">Tagged users</div>
            <div className="flex flex-wrap gap-1.5">
              {asset.userTags.map((t, i) => (
                <span
                  key={`${t.username}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[11px]"
                >
                  @{t.username}
                  <button
                    type="button"
                    onClick={() => removeTag(i)}
                    className="text-[var(--fg-subtle)] hover:text-[var(--danger)]"
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Alt text */}
        <div>
          <label className="text-xs font-medium text-[var(--fg-muted)] flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5" /> Alt text
          </label>
          <div className="relative mt-1">
            <Textarea
              ref={altRef}
              value={asset.altText}
              onChange={(e) => onChange({ ...asset, altText: e.target.value })}
              placeholder="Describe this image for screen readers…"
              maxLength={1000}
              rows={2}
              className="pr-10"
            />
            <div className="absolute right-2 top-2">
              <EmojiPickerButton
                onPick={(e) =>
                  insertAtCursor(altRef.current, asset.altText, e, (next) =>
                    onChange({ ...asset, altText: next })
                  )
                }
              />
            </div>
          </div>
          <div className="mt-1 text-right text-[11px] text-[var(--fg-subtle)]">
            {asset.altText.length} / 1000
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="accent" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
