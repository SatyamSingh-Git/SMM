"use client";

import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  Copy,
  ImagePlus,
  Loader2,
  Wand2,
  X,
} from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { ConnectionBanner } from "@/components/connection-banner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { Platform, InspireSuggestion } from "@/lib/types";
import { cn } from "@/lib/utils";

type Voice =
  | "cute"
  | "playful"
  | "flirty"
  | "bold"
  | "controversial"
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

type LanguageMix = "english" | "balanced" | "hindi-heavy";

export default function InspirePage() {
  const healthQ = useQuery({ queryKey: ["health"], queryFn: api.health });
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const accounts = accountsQ.data ?? [];

  const [platform, setPlatform] = React.useState<Platform>("threads");
  const [sourceText, setSourceText] = React.useState("");
  const [image, setImage] = React.useState<{ url: string } | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [voices, setVoices] = React.useState<Voice[]>(["cute", "playful"]);
  const [languageMix, setLanguageMix] = React.useState<LanguageMix>("english");
  const [copiedIdx, setCopiedIdx] = React.useState<number | null>(null);

  const fileRef = React.useRef<HTMLInputElement>(null);

  const generate = useMutation({
    mutationFn: () =>
      api.inspire({
        platform,
        sourceText: sourceText.trim() || undefined,
        imageUrl: image?.url,
        voices: voices.length > 0 ? voices : undefined,
        languageMix,
        count: 4,
      }),
  });

  const suggestions: InspireSuggestion[] = generate.data?.suggestions ?? [];
  const canGenerate =
    (sourceText.trim().length > 0 || !!image) && !generate.isPending && !uploading;

  function toggleVoice(v: Voice) {
    setVoices((arr) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]));
  }

  async function onFile(file: File) {
    setUploadError(null);
    if (!file.type.startsWith("image/")) {
      setUploadError("Please choose an image file.");
      return;
    }
    const accountId = accounts[0]?.id;
    if (!accountId) {
      setUploadError(
        "Connect an account first to analyze an image. (Pasting text still works.)"
      );
      return;
    }
    setUploading(true);
    try {
      const res = await api.uploadMedia(file, accountId);
      setImage({ url: res.publicUrl });
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function copy(s: InspireSuggestion, i: number) {
    const tags =
      s.hashtags.length > 0
        ? "\n\n" +
          s.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
        : "";
    try {
      await navigator.clipboard?.writeText(s.caption + tags);
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar onCompose={() => null} activeRoute="inspire" />

      <div className="flex flex-1 flex-col min-w-0">
        <Topbar
          onCompose={() => null}
          username={accounts[0]?.username ?? null}
          killSwitch={healthQ.data?.killSwitch}
        />

        <main className="flex-1 min-w-0 p-4 lg:p-6 space-y-5">
          <ConnectionBanner errors={[accountsQ.error, healthQ.error]} />

          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Wand2 className="h-5 w-5 text-[var(--accent)]" /> What to Write
            </h1>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              Saw a post you liked? Drop its picture and/or text here — get
              brand-new ideas written in your voice, not a copy of theirs.
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* ---------- Inputs ---------- */}
            <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              {/* Platform */}
              <Segmented
                label="Platform"
                options={[
                  { value: "threads", label: "Threads" },
                  { value: "instagram", label: "Instagram" },
                ]}
                value={platform}
                onChange={(v) => setPlatform(v as Platform)}
              />

              {/* Their post — image */}
              <div>
                <div className="mb-2 text-xs font-medium text-[var(--fg-muted)]">
                  Their post
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFile(f);
                    e.target.value = "";
                  }}
                />
                {image ? (
                  <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={image.url}
                      alt="reference"
                      className="h-16 w-16 rounded object-cover border border-[var(--border)]"
                    />
                    <div className="flex-1 text-xs text-[var(--fg-muted)]">
                      We&apos;ll read this image for vibe, outfit, mood &amp;
                      setting.
                    </div>
                    <button
                      type="button"
                      onClick={() => setImage(null)}
                      className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] text-[var(--fg-muted)] hover:text-fg"
                      aria-label="Remove image"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-sm text-[var(--fg-muted)] transition-colors hover:text-fg disabled:opacity-60"
                  >
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ImagePlus className="h-4 w-4" />
                    )}
                    {uploading ? "Uploading…" : "Add image (optional)"}
                  </button>
                )}
                {uploadError && (
                  <div className="mt-1.5 text-[11px] text-[var(--danger)]">
                    {uploadError}
                  </div>
                )}
              </div>

              {/* Their post — text */}
              <div>
                <Textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  placeholder="Paste the caption / text of the post that inspired you… (optional if you added an image)"
                  className="min-h-[110px]"
                  maxLength={5000}
                />
                <div className="mt-1 text-[11px] text-[var(--fg-subtle)]">
                  Add an image, paste text, or both.
                </div>
              </div>

              {/* Language */}
              <Segmented
                label="Language"
                options={[
                  { value: "english", label: "English" },
                  { value: "balanced", label: "Balanced" },
                  { value: "hindi-heavy", label: "Hindi-heavy" },
                ]}
                value={languageMix}
                onChange={(v) => setLanguageMix(v as LanguageMix)}
              />

              {/* Voices */}
              <div>
                <div className="mb-2 text-xs font-medium text-[var(--fg-muted)]">
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

              <Button
                variant="accent"
                onClick={() => generate.mutate()}
                disabled={!canGenerate}
                className="w-full"
              >
                {generate.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4" />
                )}
                Generate 4 ideas
              </Button>

              {generate.isError && (
                <div className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-3 text-xs text-[var(--danger)]">
                  {(generate.error as Error).message}
                </div>
              )}
            </div>

            {/* ---------- Results ---------- */}
            <div className="space-y-3">
              {generate.isPending && (
                <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--fg-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" /> Writing in your
                  voice…
                </div>
              )}

              {!generate.isPending && suggestions.length === 0 && (
                <div className="grid place-items-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
                  <Wand2 className="h-6 w-6 text-[var(--fg-subtle)]" />
                  <div className="mt-2 text-sm font-medium">
                    Your ideas will appear here
                  </div>
                  <div className="mt-1 text-xs text-[var(--fg-muted)]">
                    Add a post on the left and hit Generate.
                  </div>
                </div>
              )}

              {suggestions.map((s, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
                >
                  <div className="whitespace-pre-wrap text-sm text-fg">
                    {s.caption}
                  </div>
                  {s.hashtags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {s.hashtags.map((h, j) => (
                        <span
                          key={j}
                          className="text-[11px] text-[var(--accent)]"
                        >
                          {h.startsWith("#") ? h : `#${h}`}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-[11px] text-[var(--fg-subtle)]">
                      {s.caption.length} chars
                    </span>
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={() => copy(s, i)}
                    >
                      {copiedIdx === i ? (
                        <>
                          <Check className="h-3.5 w-3.5" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" /> Copy
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Segmented(props: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-[var(--fg-muted)]">
        {props.label}
      </div>
      <div className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
        {props.options.map((o) => {
          const active = props.value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => props.onChange(o.value)}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-[var(--surface)] text-fg shadow-sm"
                  : "text-[var(--fg-muted)] hover:text-fg"
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
