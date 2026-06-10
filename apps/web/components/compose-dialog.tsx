"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Camera,
  Film,
  Images,
  Loader2,
  MessageCircle,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  Users,
  Video,
  Wand2,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { Account, Platform, Post, PostType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LocationPicker } from "./location-picker";
import { AssetDetailDialog, type AssetMeta } from "./asset-detail-dialog";
import { ensureJpeg } from "@/lib/image-convert";
import { EmojiPickerButton } from "./emoji-picker-button";
import { insertAtCursor } from "@/lib/insert-at-cursor";
import { lintCaption, checkHook } from "@/lib/caption-lint";
import { nextIstSlot, slotLabel } from "@/lib/time";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Account[];
  defaultDate?: Date | null;
  // When set, the dialog opens in "edit" mode — fields pre-filled, submit PATCHes.
  editingPost?: Post | null;
};

// One segment of a Threads reply chain. Holds its own text and any media
// uploaded for that segment. Media is referenced by asset id at submit time.
type ChainItemState = { text: string; media: AssetMeta[] };

const TYPE_CONFIG: Record<
  PostType,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    media: "none" | "single-image" | "single-video" | "single-any" | "multi";
    captionMax: number;
    chain: boolean;
    hint: string;
  }
> = {
  ig_feed: { label: "Feed Post", icon: Camera, media: "single-image", captionMax: 2200, chain: false, hint: "Single JPEG." },
  ig_reel: { label: "Reel", icon: Film, media: "single-video", captionMax: 2200, chain: false, hint: "MP4 (H.264/AAC), ≤90s." },
  ig_carousel: { label: "Carousel", icon: Images, media: "multi", captionMax: 2200, chain: false, hint: "2–10 images or videos." },
  ig_story: { label: "Story", icon: Video, media: "single-any", captionMax: 0, chain: false, hint: "Image or video. No caption." },
  threads_post: { label: "Post", icon: MessageCircle, media: "multi", captionMax: 500, chain: false, hint: "Text up to 500 chars. Optional image, video, or carousel (1–20)." },
  threads_reply_chain: { label: "Reply Chain", icon: MessageCircle, media: "none", captionMax: 0, chain: true, hint: "Self-reply thread. Each segment can have text and/or media." },
};

const TYPES_BY_PLATFORM: Record<Platform, PostType[]> = {
  instagram: ["ig_feed", "ig_reel", "ig_carousel", "ig_story"],
  threads: ["threads_post", "threads_reply_chain"],
};

export function ComposeDialog({ open, onOpenChange, accounts, defaultDate, editingPost }: Props) {
  const qc = useQueryClient();
  const [platform, setPlatform] = React.useState<Platform>("threads");
  const [type, setType] = React.useState<PostType>("threads_post");
  const [caption, setCaption] = React.useState("");
  const [chain, setChain] = React.useState<ChainItemState[]>([
    { text: "", media: [] },
    { text: "", media: [] },
  ]);
  const [media, setMedia] = React.useState<AssetMeta[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [chainUploadingIdx, setChainUploadingIdx] = React.useState<number | null>(null);
  const [scheduledAt, setScheduledAt] = React.useState<string>("");
  const [aiOpen, setAiOpen] = React.useState(false);

  // IG-only extras
  const [location, setLocation] = React.useState<{ id: string; name: string } | null>(null);
  const [collaborators, setCollaborators] = React.useState<string[]>([]);
  const [collabInput, setCollabInput] = React.useState("");
  const [thumbOffsetSec, setThumbOffsetSec] = React.useState<number>(0);
  const [coverUrl, setCoverUrl] = React.useState<string>("");
  const [aiLabel, setAiLabel] = React.useState(false);
  const [igDetailsOpen, setIgDetailsOpen] = React.useState(false);

  // Per-asset detail editor
  const [assetEditingId, setAssetEditingId] = React.useState<string | null>(null);

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const captionRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (!open) return;

    if (editingPost) {
      // Hydrate from the existing post — including the advanced fields
      // (per-asset alt text + user tags, reply chain, IG extras) that the
      // payload actually carries. Previously these were silently dropped on
      // every edit, which is why editing a finished post felt destructive.
      setPlatform(editingPost.platform);
      setType(editingPost.type);
      setCaption(editingPost.caption ?? "");
      setScheduledAt(
        editingPost.scheduledAt ? toLocalDatetime(new Date(editingPost.scheduledAt)) : ""
      );

      const sortedAssets = [...editingPost.assets].sort(
        (a, b) => a.position - b.position
      );
      // Map asset id -> full AssetMeta so reply-chain segments can re-link media.
      const assetById = new Map<string, AssetMeta>();
      for (const pa of sortedAssets) {
        assetById.set(pa.asset.id, {
          id: pa.asset.id,
          publicUrl: pa.asset.publicUrl,
          mimeType: pa.asset.mimeType,
          altText: pa.altText ?? "",
          userTags: pa.userTagsJson ?? [],
        });
      }
      setMedia(sortedAssets.map((pa) => assetById.get(pa.asset.id)!));

      // Reply chain: rebuild segments from replyChainJson, re-linking each
      // segment's assetIds back to the uploaded media.
      const chainJson = editingPost.replyChainJson;
      if (editingPost.type === "threads_reply_chain" && chainJson && chainJson.length > 0) {
        setChain(
          chainJson.map((seg) => ({
            text: seg.text ?? "",
            media: (seg.assetIds ?? [])
              .map((id) => assetById.get(id))
              .filter((m): m is AssetMeta => !!m),
          }))
        );
      } else {
        setChain([{ text: "", media: [] }, { text: "", media: [] }]);
      }

      // IG extras.
      const ig = editingPost.igExtrasJson ?? null;
      setLocation(
        ig?.locationId
          ? { id: ig.locationId, name: ig.locationName ?? ig.locationId }
          : null
      );
      setCollaborators(ig?.collaborators ?? []);
      setCollabInput("");
      setThumbOffsetSec(ig?.thumbOffsetMs ? ig.thumbOffsetMs / 1000 : 0);
      setCoverUrl(ig?.coverUrl ?? "");
      setAiLabel(editingPost.aiGenerated);
      setIgDetailsOpen(
        editingPost.aiGenerated ||
          !!ig?.locationId ||
          (ig?.collaborators?.length ?? 0) > 0 ||
          !!ig?.coverUrl ||
          !!ig?.thumbOffsetMs
      );
      setAssetEditingId(null);
      return;
    }

    setCaption("");
    setChain([{ text: "", media: [] }, { text: "", media: [] }]);
    setMedia([]);
    setScheduledAt(defaultDate ? toLocalDatetime(defaultDate) : "");
    setLocation(null);
    setCollaborators([]);
    setCollabInput("");
    setThumbOffsetSec(0);
    setCoverUrl("");
    setAiLabel(false);
    setIgDetailsOpen(false);
    setAssetEditingId(null);
  }, [open, defaultDate, editingPost]);

  React.useEffect(() => {
    const allowed = TYPES_BY_PLATFORM[platform];
    if (!allowed.includes(type)) setType(allowed[0]!);
  }, [platform]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = TYPE_CONFIG[type];
  const account = accounts.find((a) => a.platform === platform);

  const acceptByType = (() => {
    // We auto-convert any image format to JPEG client-side via ensureJpeg(),
    // so the file picker can accept the broad image/* set.
    switch (cfg.media) {
      case "single-image": return "image/*";
      case "single-video": return "video/mp4";
      case "single-any":
      case "multi": return "image/*,video/mp4";
      default: return "image/*,video/mp4";
    }
  })();

  async function onPickFiles(files: FileList | null) {
    if (!files || !account || files.length === 0) return;
    setUploading(true);
    try {
      const toUpload =
        cfg.media === "multi" ? Array.from(files).slice(0, 10 - media.length) : [files[0]!];

      // Pre-flight: video duration check against Meta's spec for this content type.
      // Meta would reject these after upload anyway, but catching client-side avoids
      // a wasted upload + queue retry cycle.
      for (const f of toUpload) {
        if (!f.type.startsWith("video/")) continue;
        const dur = await probeVideoDurationSec(f);
        const limits = videoLimitsForType(type);
        if (limits.max && dur > limits.max) {
          throw new Error(
            `Video is ${dur.toFixed(1)}s — ${limits.label} accepts at most ${limits.max}s.`
          );
        }
        if (limits.min && dur < limits.min) {
          throw new Error(
            `Video is ${dur.toFixed(1)}s — ${limits.label} requires at least ${limits.min}s.`
          );
        }
      }

      const uploaded: AssetMeta[] = [];
      for (const f of toUpload) {
        // Convert any non-JPEG image to JPEG before upload so IG/Threads
        // always accept it. Videos and existing JPEGs pass through.
        const prepared = await ensureJpeg(f);
        const out = await api.uploadMedia(prepared, account.id);
        uploaded.push({
          id: out.id,
          publicUrl: out.publicUrl,
          mimeType: out.mimeType,
          altText: "",
          userTags: [],
        });
      }
      setMedia((m) => (cfg.media === "multi" ? [...m, ...uploaded] : uploaded));
    } catch (e) {
      alert("Upload failed: " + (e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  // Per-chain-item upload: pushes uploaded assets onto chain[idx].media.
  async function onChainPickFiles(idx: number, files: FileList | null) {
    if (!files || !account || files.length === 0) return;
    setChainUploadingIdx(idx);
    try {
      const toUpload = Array.from(files).slice(0, 20 - (chain[idx]?.media.length ?? 0));
      // Threads carousel videos: each video ≤5min, but we don't probe duration here.
      const uploaded: AssetMeta[] = [];
      for (const f of toUpload) {
        const prepared = await ensureJpeg(f);
        const out = await api.uploadMedia(prepared, account.id);
        uploaded.push({
          id: out.id,
          publicUrl: out.publicUrl,
          mimeType: out.mimeType,
          altText: "",
          userTags: [],
        });
      }
      setChain((arr) =>
        arr.map((item, i) =>
          i === idx ? { ...item, media: [...item.media, ...uploaded] } : item
        )
      );
    } catch (e) {
      alert("Upload failed: " + (e as Error).message);
    } finally {
      setChainUploadingIdx(null);
    }
  }

  function addCollab(raw: string) {
    const clean = raw.trim().replace(/^@/, "");
    if (!clean) return;
    if (collaborators.includes(clean)) return;
    if (collaborators.length >= 5) return;
    setCollaborators((c) => [...c, clean]);
  }

  const create = useMutation({
    mutationFn: async (opts: { mode: "now" | "schedule" | "draft" }) => {
      if (!account) throw new Error("no account configured for " + platform);
      const isoScheduledAt =
        opts.mode === "now"
          ? new Date().toISOString()
          : opts.mode === "schedule" && scheduledAt
            ? new Date(scheduledAt).toISOString()
            : null;

      const isIg = platform === "instagram";
      const igExtras = isIg
        ? {
            ...(location ? { locationId: location.id, locationName: location.name } : {}),
            ...(collaborators.length > 0 ? { collaborators } : {}),
            ...(type === "ig_reel" && thumbOffsetSec > 0
              ? { thumbOffsetMs: Math.round(thumbOffsetSec * 1000) }
              : {}),
            ...(type === "ig_reel" && coverUrl.trim() ? { coverUrl: coverUrl.trim() } : {}),
            ...(aiLabel ? { isAiGenerated: true } : {}),
          }
        : undefined;

      // Collect every asset used: single-post media + every chain item's media.
      // De-dupe by id so the PostAsset pool is clean.
      const allAssets: AssetMeta[] = [];
      const seen = new Set<string>();
      function addAssets(arr: AssetMeta[]) {
        for (const a of arr) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          allAssets.push(a);
        }
      }
      addAssets(media);
      if (cfg.chain) chain.forEach((c) => addAssets(c.media));

      const replyChainPayload = cfg.chain
        ? chain
            .map((c) => ({
              text: c.text.trim(),
              assetIds: c.media.map((m) => m.id),
            }))
            .filter((c) => c.text.length > 0 || c.assetIds.length > 0)
            .map((c) => ({
              ...(c.text ? { text: c.text } : {}),
              ...(c.assetIds.length > 0 ? { assetIds: c.assetIds } : {}),
            }))
        : undefined;

      const payload = {
        accountId: account.id,
        platform,
        type,
        caption: cfg.captionMax > 0 && caption.trim() ? caption.trim() : undefined,
        mediaAssetIds: allAssets.map((m) => m.id),
        assetMetas: allAssets.some((m) => m.altText || m.userTags.length > 0)
          ? allAssets.map((m) => ({
              assetId: m.id,
              ...(m.altText ? { altText: m.altText } : {}),
              ...(m.userTags.length > 0 ? { userTags: m.userTags } : {}),
            }))
          : undefined,
        replyChain: replyChainPayload,
        igExtras: igExtras && Object.keys(igExtras).length > 0 ? igExtras : undefined,
        scheduledAt: isoScheduledAt,
      };

      if (editingPost) {
        // PATCH the existing record. Account/platform are immutable server-side.
        return api.updatePost(editingPost.id, {
          type,
          caption: payload.caption ?? null,
          mediaAssetIds: payload.mediaAssetIds,
          assetMetas: payload.assetMetas,
          replyChain: payload.replyChain ?? null,
          igExtras: payload.igExtras ?? null,
          scheduledAt: isoScheduledAt,
        });
      }
      return api.createPost(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["posts"] });
      onOpenChange(false);
    },
  });

  // Deterministic, zero-LLM caption checks (captions only — never replies).
  const captionWarnings = React.useMemo(
    () => (cfg.captionMax > 0 ? lintCaption(caption) : []),
    [caption, cfg.captionMax]
  );
  const hookBadges = React.useMemo(
    () => (cfg.captionMax > 0 ? checkHook(caption, platform, type) : []),
    [caption, platform, type, cfg.captionMax]
  );

  // "Rewrite hook" — the only thing here that hits DeepSeek, and only on click.
  const [hookOptions, setHookOptions] = React.useState<string[] | null>(null);
  const rewriteHook = useMutation({
    mutationFn: () =>
      api.rewriteHook({ platform, caption: caption.trim() }),
    onSuccess: (hooks) => setHookOptions(hooks),
  });
  function applyHook(newFirst: string) {
    const rest = caption.split("\n").slice(1).join("\n");
    setCaption(rest ? `${newFirst}\n${rest}` : newFirst);
    setHookOptions(null);
  }

  // Data-driven IST peak-time chips (from the dashboard best-times analytics).
  const bestTimesQ = useQuery({
    queryKey: ["best-times", platform],
    queryFn: () => api.dashboardBestTimes(platform),
    enabled: open,
    staleTime: 60 * 60_000,
  });
  const peakChips = (bestTimesQ.data?.slots ?? []).slice(0, 3).map((s) => ({
    label: slotLabel(s.dayOfWeek, s.hourIst),
    get: () => nextIstSlot(s.dayOfWeek, s.hourIst),
  }));

  const validation = (() => {
    if (!account) return "No account connected for " + platform;
    if (cfg.media === "single-image" && media.length === 0) return "Add one image.";
    // (JPEG check removed — we auto-convert all images to JPEG client-side.)
    if (cfg.media === "single-video" && media[0]?.mimeType !== "video/mp4")
      return "Reels require an MP4 video.";
    if (cfg.media === "single-any" && media.length === 0) return "Add an image or video.";
    // Carousels need 2-10. Threads single posts use "multi" too but media is optional.
    if (cfg.media === "multi" && type === "ig_carousel" && media.length < 2)
      return "Carousel needs 2–10 items.";
    if (cfg.captionMax > 0 && caption.length > cfg.captionMax)
      return `Caption too long (max ${cfg.captionMax}).`;
    if (cfg.chain) {
      const filled = chain.filter((c) => c.text.trim().length > 0 || c.media.length > 0);
      if (filled.length < 2) return "Chain needs at least 2 segments with text or media.";
      if (filled.some((c) => c.text.length > 500))
        return "Each chain item ≤500 chars.";
    } else if (type === "threads_post" && !caption.trim() && media.length === 0) {
      return "Add some text or media.";
    } else if (cfg.media === "none" && !caption.trim()) return "Add some text.";
    return null;
  })();
  const canSubmit = !validation && !create.isPending && !uploading;

  const showIgDetails = platform === "instagram";
  const editingAsset = assetEditingId ? media.find((m) => m.id === assetEditingId) ?? null : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0 overflow-hidden max-h-[92vh] flex flex-col">
        <div className="grid md:grid-cols-[1fr_360px] min-h-0 flex-1 overflow-hidden">
          {/* LEFT — composer */}
          <div className="flex min-h-0 flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-3 space-y-4">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-[var(--accent)]" />
                  {editingPost ? "Edit post" : "New post"}
                </DialogTitle>
                <DialogDescription>{cfg.hint}</DialogDescription>
              </DialogHeader>

              <Tabs value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <TabsList>
                  <TabsTrigger value="threads"><MessageCircle className="h-4 w-4" /> Threads</TabsTrigger>
                  <TabsTrigger value="instagram"><Camera className="h-4 w-4" /> Instagram</TabsTrigger>
                </TabsList>
                <TabsContent value="threads" />
                <TabsContent value="instagram" />
              </Tabs>

              <div className="flex flex-wrap gap-2">
                {TYPES_BY_PLATFORM[platform].map((t) => {
                  const c = TYPE_CONFIG[t];
                  const Icon = c.icon;
                  const active = t === type;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setType(t)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
                        active
                          ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                          : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />{c.label}
                    </button>
                  );
                })}
              </div>

              {/* Media */}
              {cfg.media !== "none" && (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={acceptByType}
                    hidden
                    multiple={cfg.media === "multi"}
                    onChange={(e) => { onPickFiles(e.target.files); e.target.value = ""; }}
                  />
                  {media.length === 0 ? (
                    <UploadBox
                      label={
                        uploading ? "Converting + uploading…"
                        : cfg.media === "multi" ? "Add 2–10 images/videos"
                        : cfg.media === "single-video" ? "Drop an MP4"
                        : cfg.media === "single-image" ? "Drop any image (auto-converted to JPEG)"
                        : "Drop image or video"
                      }
                      uploading={uploading}
                      onClick={() => fileInputRef.current?.click()}
                    />
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {media.map((m, i) => (
                        <MediaThumb
                          key={m.id}
                          item={m}
                          showIgChips={platform === "instagram"}
                          onClick={() => platform === "instagram" && setAssetEditingId(m.id)}
                          onRemove={() => setMedia((arr) => arr.filter((_, idx) => idx !== i))}
                        />
                      ))}
                      {cfg.media === "multi" && media.length < 10 && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploading}
                          className="grid aspect-square place-items-center rounded-lg border-2 border-dashed border-[var(--border)] text-[var(--fg-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        >
                          {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
                        </button>
                      )}
                    </div>
                  )}
                  {platform === "instagram" && media.length > 0 && (
                    <div className="mt-1.5 text-[11px] text-[var(--fg-subtle)]">
                      Click any thumbnail to add alt text or tag people.
                    </div>
                  )}
                </div>
              )}

              {/* Caption */}
              {cfg.captionMax > 0 && (
                <div>
                  <div className="relative">
                    <Textarea
                      ref={captionRef}
                      value={caption}
                      onChange={(e) => setCaption(e.target.value)}
                      placeholder={platform === "threads" ? "What's on your mind?" : "Write a caption…"}
                      maxLength={cfg.captionMax}
                      className="pr-10"
                    />
                    <div className="absolute right-2 top-2">
                      <EmojiPickerButton
                        onPick={(e) =>
                          insertAtCursor(captionRef.current, caption, e, setCaption)
                        }
                      />
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--fg-subtle)]">
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="ghost" size="sm" className="h-7 -ml-2 px-2 text-[var(--accent)] hover:text-[var(--accent)]" onClick={() => setAiOpen(true)}>
                        <Sparkles className="h-3.5 w-3.5" /> AI suggest
                      </Button>
                      {caption.trim().length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => rewriteHook.mutate()}
                          disabled={rewriteHook.isPending}
                          title="Rewrite just the first line (the hook)"
                        >
                          {rewriteHook.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Wand2 className="h-3.5 w-3.5" />
                          )}
                          Rewrite hook
                        </Button>
                      )}
                    </div>
                    <span
                      className={cn(
                        caption.length > cfg.captionMax && "text-[var(--danger)]"
                      )}
                    >
                      {caption.length} / {cfg.captionMax}
                    </span>
                  </div>

                  {/* Hook badges + lint warnings (deterministic, no LLM). */}
                  {(hookBadges.length > 0 || captionWarnings.length > 0) && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {hookBadges.map((b, i) => (
                        <span
                          key={`h${i}`}
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                            b.tone === "good"
                              ? "bg-[var(--success)]/15 text-[var(--success)]"
                              : "bg-amber-500/15 text-amber-600"
                          )}
                        >
                          {b.label}
                        </span>
                      ))}
                      {captionWarnings.map((w, i) => (
                        <span
                          key={`w${i}`}
                          className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600"
                          title={w.message}
                        >
                          {w.message}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Rewrite-hook options popover */}
                  {hookOptions && hookOptions.length > 0 && (
                    <div className="mt-2 space-y-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2">
                      <div className="flex items-center justify-between px-1 text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
                        Tap a stronger hook
                        <button
                          type="button"
                          onClick={() => setHookOptions(null)}
                          className="text-[var(--fg-subtle)] hover:text-fg"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      {hookOptions.map((h, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => applyHook(h)}
                          className="block w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-left text-xs hover:border-[var(--accent)]"
                        >
                          {h}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Reply chain */}
              {cfg.chain && (
                <div className="space-y-3">
                  <div className="text-xs font-medium text-[var(--fg-muted)]">
                    Thread chain
                  </div>
                  {chain.map((item, i) => (
                    <ChainSegment
                      key={i}
                      index={i}
                      item={item}
                      removable={chain.length > 2}
                      uploading={chainUploadingIdx === i}
                      onTextChange={(text) =>
                        setChain((c) => c.map((v, idx) => (idx === i ? { ...v, text } : v)))
                      }
                      onPickFiles={(files) => onChainPickFiles(i, files)}
                      onRemoveMedia={(mediaIdx) =>
                        setChain((c) =>
                          c.map((v, idx) =>
                            idx === i
                              ? { ...v, media: v.media.filter((_, mi) => mi !== mediaIdx) }
                              : v
                          )
                        )
                      }
                      onRemove={() =>
                        setChain((c) => c.filter((_, idx) => idx !== i))
                      }
                    />
                  ))}
                  {chain.length < 20 && (
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={() =>
                        setChain((c) => [...c, { text: "", media: [] }])
                      }
                    >
                      <Plus className="h-3.5 w-3.5" /> Add segment
                    </Button>
                  )}
                </div>
              )}

              {/* IG details collapsible */}
              {showIgDetails && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
                  <button
                    type="button"
                    onClick={() => setIgDetailsOpen((b) => !b)}
                    className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium"
                  >
                    <span className="flex items-center gap-2">
                      <Settings2 className="h-4 w-4 text-[var(--accent)]" />
                      Instagram details
                      {(location || collaborators.length > 0 || aiLabel || (type === "ig_reel" && (thumbOffsetSec > 0 || coverUrl))) && (
                        <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] text-[var(--accent)]">
                          customized
                        </span>
                      )}
                    </span>
                    <span className="text-[var(--fg-subtle)]">{igDetailsOpen ? "−" : "+"}</span>
                  </button>
                  {igDetailsOpen && (
                    <div className="space-y-4 border-t border-[var(--border)] p-4">
                      {/* Location */}
                      {account && (
                        <div>
                          <label className="text-xs font-medium text-[var(--fg-muted)]">Location</label>
                          <div className="mt-1.5">
                            <LocationPicker
                              accountId={account.id}
                              value={location}
                              onChange={setLocation}
                            />
                          </div>
                        </div>
                      )}

                      {/* Collaborators */}
                      <div>
                        <label className="text-xs font-medium text-[var(--fg-muted)] flex items-center gap-1.5">
                          <Users className="h-3.5 w-3.5" /> Collaborators (up to 5)
                        </label>
                        <div className="mt-1.5">
                          <div className="flex flex-wrap gap-1.5 mb-1.5">
                            {collaborators.map((c, i) => (
                              <span key={c} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-xs">
                                @{c}
                                <button type="button" onClick={() => setCollaborators((arr) => arr.filter((_, idx) => idx !== i))} className="text-[var(--fg-subtle)] hover:text-[var(--danger)]">
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            ))}
                          </div>
                          <Input
                            value={collabInput}
                            onChange={(e) => setCollabInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === ",") {
                                e.preventDefault();
                                addCollab(collabInput);
                                setCollabInput("");
                              }
                            }}
                            placeholder={collaborators.length >= 5 ? "Max 5 collaborators" : "Type @username, press Enter"}
                            disabled={collaborators.length >= 5}
                          />
                        </div>
                      </div>

                      {/* Reel-specific */}
                      {type === "ig_reel" && (
                        <ReelCoverPanel
                          accountId={account?.id}
                          thumbOffsetSec={thumbOffsetSec}
                          setThumbOffsetSec={setThumbOffsetSec}
                          coverUrl={coverUrl}
                          setCoverUrl={setCoverUrl}
                        />
                      )}

                      {/* AI label */}
                      <label className="flex cursor-pointer items-start gap-2 border-t border-[var(--border)] pt-3">
                        <input
                          type="checkbox"
                          checked={aiLabel}
                          onChange={(e) => setAiLabel(e.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                        />
                        <div className="text-xs">
                          <div className="flex items-center gap-1.5 font-medium">
                            <Wand2 className="h-3.5 w-3.5 text-[var(--accent)]" /> Mark as AI-generated
                          </div>
                          <div className="mt-0.5 text-[11px] text-[var(--fg-subtle)]">
                            We&apos;ll flag this internally. Meta auto-detects from media metadata; if it doesn&apos;t, toggle &quot;AI Info&quot; on the post inside the IG app after publish.
                          </div>
                        </div>
                      </label>
                    </div>
                  )}
                </div>
              )}

              {/* Schedule */}
              <div>
                <label className="text-xs font-medium text-[var(--fg-muted)]">
                  Schedule <span className="text-[var(--fg-subtle)]">(local time)</span>
                </label>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--fg-subtle)]" />
                    <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="pl-8 w-[230px]" />
                  </div>
                  {/* Data-driven IST peak chips when we have history; else fallbacks. */}
                  {(peakChips.length > 0
                    ? peakChips
                    : [
                        { label: "Tonight 8pm", get: tonight8 },
                        { label: "Tomorrow 9am", get: tomorrow9 },
                        { label: "Next Mon 12pm", get: nextMon12 },
                      ]
                  ).map((q) => (
                    <Button key={q.label} variant="soft" size="sm" onClick={() => setScheduledAt(toLocalDatetime(q.get()))} title={peakChips.length > 0 ? "Your best-performing IST slot" : undefined}>{q.label}</Button>
                  ))}
                </div>
                {peakChips.length > 0 && (
                  <div className="mt-1 text-[10px] text-[var(--fg-subtle)]">
                    Chips are your top IST engagement slots from post history.
                  </div>
                )}
              </div>

              {create.isError && (
                <div className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-3 text-xs text-[var(--danger)]">
                  {(create.error as Error).message}
                </div>
              )}
            </div>

            <div className="border-t border-[var(--border)] bg-[var(--surface)] px-6 py-3 flex items-center justify-between gap-2">
              <div className="truncate text-[11px] text-[var(--fg-subtle)]">
                {validation ? validation : `Posting as ${account?.username ?? "—"} · ${cfg.label}`}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={() => create.mutate({ mode: "draft" })}
                  disabled={!canSubmit}
                  title="Save without scheduling"
                >
                  Save draft
                </Button>
                <Button variant="outline" onClick={() => create.mutate({ mode: "now" })} disabled={!canSubmit}>
                  {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Post now
                </Button>
                <Button variant="accent" onClick={() => create.mutate({ mode: "schedule" })} disabled={!canSubmit || !scheduledAt}>
                  Schedule
                </Button>
              </div>
            </div>
          </div>

          {/* RIGHT — preview */}
          <div className="hidden overflow-y-auto border-l border-[var(--border)] bg-[var(--surface-2)] p-6 md:block">
            <div className="text-xs font-medium uppercase tracking-wider text-[var(--fg-muted)]">Preview</div>
            <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[var(--accent)] to-amber-400" />
                <div className="leading-tight">
                  <div className="text-sm font-semibold">{account?.username ?? "your_account"}</div>
                  <div className="text-[11px] text-[var(--fg-muted)]">
                    {platform === "instagram" ? "Instagram" : "Threads"} · {cfg.label}
                  </div>
                  {location && (
                    <div className="text-[11px] text-[var(--fg-subtle)]">📍 {location.name}</div>
                  )}
                </div>
              </div>
              {media.length > 0 && (
                <div className={cn("mt-3 overflow-hidden rounded-lg", media.length > 1 && "grid grid-cols-2 gap-1")}>
                  {media.slice(0, 4).map((m) => m.mimeType.startsWith("video/") ? (
                    <video key={m.id} src={m.publicUrl} className="max-h-64 w-full object-cover" />
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img key={m.id} src={m.publicUrl} alt="" className="max-h-64 w-full object-cover" />
                  ))}
                </div>
              )}
              {cfg.captionMax > 0 && caption && (
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{caption}</p>
              )}
              {cfg.chain && (
                <div className="mt-3 space-y-3 border-l-2 border-[var(--border)] pl-3">
                  {chain
                    .filter((c) => c.text.trim().length > 0 || c.media.length > 0)
                    .map((c, i) => (
                      <div key={i} className="space-y-2">
                        {c.text && (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed">
                            {c.text}
                          </p>
                        )}
                        {c.media.length > 0 && (
                          <div
                            className={cn(
                              "overflow-hidden rounded-lg",
                              c.media.length > 1 && "grid grid-cols-2 gap-1"
                            )}
                          >
                            {c.media.slice(0, 4).map((m) =>
                              m.mimeType.startsWith("video/") ? (
                                <video
                                  key={m.id}
                                  src={m.publicUrl}
                                  className="max-h-40 w-full object-cover"
                                />
                              ) : (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                  key={m.id}
                                  src={m.publicUrl}
                                  alt=""
                                  className="max-h-40 w-full object-cover"
                                />
                              )
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}
              {collaborators.length > 0 && (
                <div className="mt-3 text-[11px] text-[var(--fg-subtle)]">
                  With {collaborators.map((c) => "@" + c).join(", ")}
                </div>
              )}
              {aiLabel && (
                <div className="mt-2 inline-flex items-center gap-1 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                  <Wand2 className="h-3 w-3" /> AI info
                </div>
              )}
            </div>
            <div className="mt-3 text-[11px] text-[var(--fg-subtle)]">
              Media is served via{" "}
              <code className="rounded bg-[var(--surface)] px-1 py-0.5">PUBLIC_BASE_URL</code>{" "}
              (your Cloudflare Tunnel) so Meta can fetch it.
            </div>
          </div>
        </div>
      </DialogContent>

      <AiSuggestDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        platform={platform}
        postType={type}
        currentCaption={caption}
        firstImageUrl={
          media.find((m) => m.mimeType.startsWith("image/"))?.publicUrl ?? null
        }
        onPick={(text) => {
          setCaption(text);
          setAiOpen(false);
        }}
      />

      <AssetDetailDialog
        open={!!editingAsset}
        onOpenChange={(b) => { if (!b) setAssetEditingId(null); }}
        asset={editingAsset}
        onChange={(meta) => setMedia((arr) => arr.map((a) => (a.id === meta.id ? meta : a)))}
      />
    </Dialog>
  );
}

// ----- subcomponents -----

function ChainSegment(props: {
  index: number;
  item: ChainItemState;
  removable: boolean;
  uploading: boolean;
  onTextChange: (text: string) => void;
  onPickFiles: (files: FileList | null) => void;
  onRemoveMedia: (mediaIdx: number) => void;
  onRemove: () => void;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  const { item, index, uploading } = props;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="flex items-start gap-2">
        <div className="mt-1.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--surface)] text-[10px] font-semibold text-[var(--fg-muted)]">
          {index + 1}
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <div className="relative">
            <Textarea
              ref={textRef}
              value={item.text}
              onChange={(e) => props.onTextChange(e.target.value)}
              placeholder={
                index === 0
                  ? "Opening thought (optional if you have media)…"
                  : "Continue the thread…"
              }
              maxLength={500}
              rows={2}
              className="pr-10"
            />
            <div className="absolute right-2 top-2">
              <EmojiPickerButton
                onPick={(e) =>
                  insertAtCursor(textRef.current, item.text, e, props.onTextChange)
                }
              />
            </div>
          </div>
          {/* Per-item media */}
          {item.media.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5">
              {item.media.map((m, mi) => (
                <div key={m.id} className="relative aspect-square overflow-hidden rounded-md border border-[var(--border)]">
                  {m.mimeType.startsWith("video/") ? (
                    <video src={m.publicUrl} className="h-full w-full object-cover" />
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={m.publicUrl} alt="" className="h-full w-full object-cover" />
                  )}
                  <button
                    type="button"
                    onClick={() => props.onRemoveMedia(mi)}
                    className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
                    aria-label="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between text-[11px] text-[var(--fg-subtle)]">
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/mp4"
              hidden
              multiple
              onChange={(e) => {
                props.onPickFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || item.media.length >= 20}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 hover:bg-[var(--surface-2)] disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {item.media.length === 0 ? "Add media" : `Add more (${item.media.length}/20)`}
            </button>
            <span>{item.text.length} / 500</span>
          </div>
        </div>
        {props.removable && (
          <button
            type="button"
            onClick={props.onRemove}
            className="mt-1.5 text-[var(--fg-subtle)] hover:text-[var(--danger)]"
            aria-label="Remove segment"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function ReelCoverPanel(props: {
  accountId: string | undefined;
  thumbOffsetSec: number;
  setThumbOffsetSec: (n: number) => void;
  coverUrl: string;
  setCoverUrl: (s: string) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function onPick(file: File) {
    if (!props.accountId) return;
    if (!file.type.startsWith("image/")) {
      setErr("Cover must be an image.");
      return;
    }
    setUploading(true);
    setErr(null);
    try {
      // Auto-convert PNG / WEBP / etc. to JPEG (Meta requires JPEG for Reel covers).
      const prepared = await ensureJpeg(file);
      const out = await api.uploadMedia(prepared, props.accountId);
      props.setCoverUrl(out.publicUrl);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-[var(--border)] pt-3">
      <div className="text-xs font-medium text-[var(--fg-muted)] flex items-center gap-1.5">
        <Film className="h-3.5 w-3.5" /> Reel cover
      </div>
      <div>
        <label className="text-[11px] text-[var(--fg-subtle)]">
          Cover frame (seconds into video)
        </label>
        <Input
          type="number"
          min={0}
          step={0.1}
          value={props.thumbOffsetSec}
          onChange={(e) => props.setThumbOffsetSec(Number(e.target.value))}
          className="mt-1"
        />
      </div>
      <div>
        <label className="text-[11px] text-[var(--fg-subtle)]">
          Or custom cover (overrides frame)
        </label>
        <div className="mt-1 flex items-stretch gap-2">
          <Input
            type="url"
            value={props.coverUrl}
            onChange={(e) => props.setCoverUrl(e.target.value)}
            placeholder="https://…/cover.jpg or upload →"
            className="flex-1"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="soft"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || !props.accountId}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload
          </Button>
        </div>
        {props.coverUrl && (
          <div className="mt-2 flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={props.coverUrl}
              alt="cover preview"
              className="h-12 w-12 rounded border border-[var(--border)] object-cover"
            />
            <button
              type="button"
              onClick={() => props.setCoverUrl("")}
              className="text-[11px] text-[var(--fg-subtle)] hover:text-[var(--danger)]"
            >
              Remove
            </button>
          </div>
        )}
        {err && (
          <div className="mt-1 text-[11px] text-[var(--danger)]">{err}</div>
        )}
      </div>
    </div>
  );
}

function UploadBox(props: { label: string; uploading: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.uploading}
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[var(--border)] bg-[var(--surface-2)] py-10 text-sm text-[var(--fg-muted)] transition-colors",
        "hover:border-[var(--accent)] hover:text-[var(--accent)] hover:bg-[var(--accent-soft)]/40",
        props.uploading && "pointer-events-none opacity-60"
      )}
    >
      {props.uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
      <span>{props.label}</span>
      <span className="text-[11px] text-[var(--fg-subtle)]">Up to 100MB · JPEG, PNG, MP4</span>
    </button>
  );
}

function MediaThumb(props: {
  item: AssetMeta;
  showIgChips: boolean;
  onClick: () => void;
  onRemove: () => void;
}) {
  const isVideo = props.item.mimeType.startsWith("video/");
  const hasMeta = props.item.altText.length > 0 || props.item.userTags.length > 0;
  return (
    <div className="relative aspect-square overflow-hidden rounded-lg border border-[var(--border)] bg-black group">
      <button
        type="button"
        onClick={props.onClick}
        className="block h-full w-full"
        aria-label={props.showIgChips ? "Edit alt text and tags" : "Preview"}
      >
        {isVideo ? (
          <video src={props.item.publicUrl} className="h-full w-full object-cover" />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={props.item.publicUrl} alt="" className="h-full w-full object-cover" />
        )}
        {props.showIgChips && (
          <div className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/30" />
        )}
      </button>

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); props.onRemove(); }}
        className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
        aria-label="Remove"
      >
        <X className="h-3 w-3" />
      </button>

      {props.showIgChips && hasMeta && (
        <div className="pointer-events-none absolute bottom-1 left-1 right-1 flex items-center gap-1 text-[10px] text-white">
          {props.item.userTags.length > 0 && (
            <span className="rounded bg-black/70 px-1.5 py-0.5">@{props.item.userTags.length}</span>
          )}
          {props.item.altText && (
            <span className="rounded bg-black/70 px-1.5 py-0.5">alt</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---- AI suggest dialog ----

type AiMode = "fresh" | "enhance" | "from-image";
type Voice =
  | "playful"
  | "cute"
  | "controversial"
  | "flirty"
  | "bold"
  | "mysterious"
  | "soft"
  | "edgy"
  | "viral-bait";

const VOICE_CATALOG: Array<{ id: Voice; label: string; emoji: string; hint: string }> = [
  { id: "cute", label: "Cute", emoji: "🩷", hint: "soft-girl, hearts" },
  { id: "playful", label: "Playful", emoji: "😋", hint: "light, mischievous" },
  { id: "flirty", label: "Flirty", emoji: "👀", hint: "teasing tension" },
  { id: "bold", label: "Bold", emoji: "✨", hint: "main character energy" },
  { id: "controversial", label: "Spicy", emoji: "🔥", hint: "agree-or-fight take" },
  { id: "mysterious", label: "Mysterious", emoji: "🌙", hint: "intrigue, ellipsis" },
  { id: "soft", label: "Soft", emoji: "🥺", hint: "raw, vulnerable" },
  { id: "edgy", label: "Edgy", emoji: "🖤", hint: "cool, sarcastic" },
  { id: "viral-bait", label: "Viral", emoji: "💯", hint: "optimized for shares" },
];

function AiSuggestDialog(props: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  platform: Platform;
  postType: PostType;
  currentCaption: string;
  firstImageUrl: string | null;
  onPick: (caption: string) => void;
}) {
  // Default voices: cute + playful (the brand's home base)
  const [voices, setVoices] = React.useState<Voice[]>(["cute", "playful"]);
  // Default language: pure Gen-Z English (matches how real viral creators write).
  const [languageMix, setLanguageMix] = React.useState<
    "english" | "balanced" | "hindi-heavy"
  >("english");
  const [intent, setIntent] = React.useState("");
  // Auto-pick the best mode based on what's available:
  //   - has image AND no draft  -> from-image
  //   - has draft (≥10 chars)   -> enhance
  //   - else                    -> fresh
  const initialMode = React.useMemo<AiMode>(() => {
    if (props.firstImageUrl && (!props.currentCaption || props.currentCaption.trim().length < 10))
      return "from-image";
    if (props.currentCaption && props.currentCaption.trim().length >= 10) return "enhance";
    return "fresh";
  }, [props.firstImageUrl, props.currentCaption]);
  const [mode, setMode] = React.useState<AiMode>(initialMode);
  const [suggestions, setSuggestions] = React.useState<
    Array<{ caption: string; hashtags: string[] }>
  >([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (props.open) {
      setSuggestions([]);
      setError(null);
      setMode(initialMode);
    }
  }, [props.open, initialMode]);

  function toggleVoice(v: Voice) {
    setVoices((arr) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]));
  }

  async function generate() {
    setLoading(true);
    setError(null);
    setSuggestions([]);
    try {
      const out = await api.suggestCaptions({
        platform: props.platform,
        postType: props.postType,
        mode,
        existingCaption: mode === "enhance" ? props.currentCaption : undefined,
        imageUrl: mode === "from-image" ? props.firstImageUrl ?? undefined : undefined,
        voices: voices.length > 0 ? voices : undefined,
        languageMix,
        intent: intent.trim() || undefined,
        count: 3,
      });
      setSuggestions(out.suggestions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const modeDescription =
    mode === "from-image"
      ? "Captions inspired by your uploaded image."
      : mode === "enhance"
        ? "Rewriting your draft in the brand voice."
        : "Fresh captions from scratch.";

  const canFromImage = !!props.firstImageUrl;
  const canEnhance = (props.currentCaption ?? "").trim().length >= 10;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--accent)]" /> AI caption assist
          </DialogTitle>
          <DialogDescription>{modeDescription}</DialogDescription>
        </DialogHeader>

        <div className="mt-2 flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          {/* Mode selector */}
          <div className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
            <ModeChip
              active={mode === "fresh"}
              onClick={() => setMode("fresh")}
              label="Fresh"
              hint="From scratch"
            />
            <ModeChip
              active={mode === "enhance"}
              onClick={() => canEnhance && setMode("enhance")}
              disabled={!canEnhance}
              label="Enhance"
              hint={canEnhance ? "Rewrite my draft" : "Type a draft first"}
            />
            <ModeChip
              active={mode === "from-image"}
              onClick={() => canFromImage && setMode("from-image")}
              disabled={!canFromImage}
              label="From image"
              hint={canFromImage ? "Look at my photo" : "Add an image first"}
            />
          </div>

          {/* Image preview in from-image mode */}
          {mode === "from-image" && props.firstImageUrl && (
            <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={props.firstImageUrl}
                alt="reference"
                className="h-16 w-16 rounded object-cover border border-[var(--border)]"
              />
              <div className="text-xs text-[var(--fg-muted)]">
                Qwen3-VL will look at this image and write captions referencing
                the outfit, colors, mood, and vibe.
              </div>
            </div>
          )}

          {/* Current draft preview in enhance mode */}
          {mode === "enhance" && canEnhance && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <div className="text-[10px] uppercase tracking-wider text-[var(--fg-muted)] mb-1">
                Your draft
              </div>
              <div className="text-sm whitespace-pre-wrap line-clamp-4">
                {props.currentCaption}
              </div>
            </div>
          )}

          {/* Language mix */}
          <div>
            <div className="text-xs font-medium text-[var(--fg-muted)] mb-2">
              Language
            </div>
            <div className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
              <LanguageChip
                active={languageMix === "english"}
                onClick={() => setLanguageMix("english")}
                label="English"
                hint="Gen-Z, no Hindi"
              />
              <LanguageChip
                active={languageMix === "balanced"}
                onClick={() => setLanguageMix("balanced")}
                label="Balanced"
                hint="English + light Hindi"
              />
              <LanguageChip
                active={languageMix === "hindi-heavy"}
                onClick={() => setLanguageMix("hindi-heavy")}
                label="Hindi-heavy"
                hint="~40% Hindi"
              />
            </div>
          </div>

          {/* Voice modifiers */}
          <div>
            <div className="text-xs font-medium text-[var(--fg-muted)] mb-2">
              Tone — pick any combination
            </div>
            <div className="flex flex-wrap gap-1.5">
              {VOICE_CATALOG.map((v) => {
                const active = voices.includes(v.id);
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => toggleVoice(v.id)}
                    title={v.hint}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
                    )}
                  >
                    <span>{v.emoji}</span>
                    {v.label}
                  </button>
                );
              })}
            </div>
            {voices.length === 0 && (
              <div className="mt-1.5 text-[11px] text-[var(--fg-subtle)]">
                Defaults to cute + playful if you skip this.
              </div>
            )}
          </div>

          {/* Optional intent */}
          <div>
            <div className="text-xs font-medium text-[var(--fg-muted)] mb-1.5">
              Anything specific? <span className="text-[var(--fg-subtle)]">(optional)</span>
            </div>
            <IntentInput value={intent} onChange={setIntent} />
          </div>

          <Button
            variant="accent"
            onClick={generate}
            disabled={loading}
            className="w-full"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Generate 3 suggestions
          </Button>

          {error && (
            <div className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-3 text-xs text-[var(--danger)]">
              {error}
            </div>
          )}

          {suggestions.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-[var(--fg-muted)]">
                Tap one to apply
              </div>
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() =>
                    props.onPick(
                      s.caption +
                        (s.hashtags?.length
                          ? "\n\n" +
                            s.hashtags
                              .map((h) => `#${h.replace(/^#/, "")}`)
                              .join(" ")
                          : "")
                    )
                  }
                  className="block w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-left text-sm transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/40"
                >
                  <div className="whitespace-pre-wrap leading-relaxed">
                    {s.caption}
                  </div>
                  {s.hashtags?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-[var(--accent)]">
                      {s.hashtags.map((h, hi) => (
                        <span key={hi}>#{h.replace(/^#/, "")}</span>
                      ))}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IntentInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. mention monsoon, college vibe, my new lipstick…"
        rows={2}
        className="pr-10"
      />
      <div className="absolute right-2 top-2">
        <EmojiPickerButton
          onPick={(e) => insertAtCursor(ref.current, value, e, onChange)}
        />
      </div>
    </div>
  );
}

function LanguageChip({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-[var(--surface)] text-fg shadow-sm"
          : "text-[var(--fg-muted)] hover:text-[var(--fg)]"
      )}
    >
      {label}
      <div className="text-[10px] font-normal text-[var(--fg-subtle)] mt-0.5">
        {hint}
      </div>
    </button>
  );
}

function ModeChip({
  active,
  disabled,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={cn(
        "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-[var(--surface)] text-fg shadow-sm"
          : "text-[var(--fg-muted)] hover:text-[var(--fg)]",
        disabled && "opacity-40 cursor-not-allowed hover:text-[var(--fg-muted)]"
      )}
    >
      {label}
      <div className="text-[10px] font-normal text-[var(--fg-subtle)] mt-0.5">{hint}</div>
    </button>
  );
}

// ----- utils -----

function videoLimitsForType(t: PostType): { min?: number; max?: number; label: string } {
  // Meta's published specs (give a small margin where unclear):
  //   Reel:  3–90s (we accept slightly under 90 as Meta sometimes rejects 89.9s files)
  //   Story: ≤60s
  //   Carousel video: ≤60s per item (we don't enforce strictly — Meta returns a clear error)
  //   Feed video: ≤60s (Reels recommended instead)
  if (t === "ig_reel") return { min: 3, max: 90, label: "Reel" };
  if (t === "ig_story") return { max: 60, label: "Story" };
  if (t === "ig_carousel") return { max: 60, label: "Carousel video" };
  return { label: "video" };
}

function probeVideoDurationSec(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      v.removeAttribute("src");
      v.load();
    };
    v.onloadedmetadata = () => {
      const d = v.duration;
      cleanup();
      if (Number.isFinite(d) && d > 0) resolve(d);
      else reject(new Error("could not read video duration"));
    };
    v.onerror = () => {
      cleanup();
      reject(new Error("could not load video metadata"));
    };
    v.src = url;
  });
}

function toLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function tonight8(): Date { const d = new Date(); d.setHours(20, 0, 0, 0); return d; }
function tomorrow9(): Date { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; }
function nextMon12(): Date {
  const d = new Date(); const day = d.getDay(); const delta = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + delta); d.setHours(12, 0, 0, 0); return d;
}
