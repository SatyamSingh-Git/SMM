"use client";

import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { ConnectionBanner } from "@/components/connection-banner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { api, type ImagePromptOptionCatalog } from "@/lib/api";
import { cn } from "@/lib/utils";

const PERSONA_LS_KEY = "smm.imagePrompt.persona";
const TONE_LS_KEY = "smm.imagePrompt.defaultTone";

const SCENE_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Rooftop sunset · saree", value: "rooftop terrace at golden-hour sunset, hair loose with wind motion" },
  { label: "Monsoon street", value: "monsoon-wet Mumbai street at dusk, reflected neon puddles, wet hair clinging to neck, single droplet at jawline" },
  { label: "Café candid", value: "café with brass railings and afternoon haze, hair in a loose low bun, candid mid-laugh with chai cup" },
  { label: "Mirror selfie", value: "bathroom mirror with soft vanity light, phone in one hand at hip height, other hand in hair" },
  { label: "Beach golden hour", value: "beach golden hour with wet sand reflection, sarong loose at the hip, walking along the waterline" },
  { label: "Gym post-workout", value: "gym mirror against chrome plates, fine sheen at the collarbone, hair pulled back in a high ponytail" },
  { label: "Bedroom morning", value: "bedroom morning with white linen and dust-light through curtains, knees pulled up on the bed reading her phone" },
  { label: "Wedding sangeet", value: "wedding sangeet under fairy lights, mid-spin so the skirt flares, head tilted back laughing" },
];

type OptionKey = keyof ImagePromptOptionCatalog;
type SingleOptionKey = Exclude<OptionKey, "hairstyle" | "cameraAngle">;

const OPTION_GROUPS: Array<{
  key: SingleOptionKey;
  label: string;
  hint?: string;
}> = [
  { key: "outfit", label: "Outfit", hint: "or describe in the scene above" },
  { key: "shotType", label: "Picture type" },
  { key: "cameraQuality", label: "Camera quality" },
  { key: "photographer", label: "Photographer" },
  { key: "locale", label: "Scene / locale" },
  { key: "lighting", label: "Lighting" },
];

export default function PromptsPage() {
  const healthQ = useQuery({ queryKey: ["health"], queryFn: api.health });
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const accounts = accountsQ.data ?? [];

  const personaDefaultQ = useQuery({
    queryKey: ["imagePromptPersonaDefault"],
    queryFn: api.getImagePromptPersonaDefault,
    staleTime: Infinity,
  });

  const optionsQ = useQuery({
    queryKey: ["imagePromptOptions"],
    queryFn: api.getImagePromptOptions,
    staleTime: Infinity,
  });

  const [scene, setScene] = React.useState("");
  const [persona, setPersona] = React.useState("");
  const [personaLoaded, setPersonaLoaded] = React.useState(false);
  const [personaOpen, setPersonaOpen] = React.useState(false);
  const [count, setCount] = React.useState<1 | 3 | 6>(3);

  // One state slot per single-select chip group. Empty string = "model decides".
  const [picks, setPicks] = React.useState<
    Partial<Record<SingleOptionKey, string>>
  >({});
  // Hairstyle is multi-select (pool — model picks one for the shoot).
  const [hairstyles, setHairstyles] = React.useState<string[]>([]);
  // Camera angles are multi-select, capped at `count` — each prompt uses a
  // distinct angle. Empty = "model decides".
  const [cameraAngles, setCameraAngles] = React.useState<string[]>([]);
  // Default tone (flirty / girlfriend-pose / body-flattering) — on by default.
  const [defaultTone, setDefaultTone] = React.useState<boolean>(true);
  const [toneLoaded, setToneLoaded] = React.useState(false);

  const [copiedIdx, setCopiedIdx] = React.useState<number | null>(null);
  const [copiedAll, setCopiedAll] = React.useState(false);

  React.useEffect(() => {
    if (personaLoaded) return;
    try {
      const saved = window.localStorage.getItem(PERSONA_LS_KEY);
      if (saved) setPersona(saved);
    } catch {
      /* localStorage blocked */
    }
    setPersonaLoaded(true);
  }, [personaLoaded]);

  React.useEffect(() => {
    if (!personaLoaded) return;
    try {
      if (persona.trim()) {
        window.localStorage.setItem(PERSONA_LS_KEY, persona);
      } else {
        window.localStorage.removeItem(PERSONA_LS_KEY);
      }
    } catch {
      /* silent */
    }
  }, [persona, personaLoaded]);

  // Load tone preference (default ON) from localStorage on mount.
  React.useEffect(() => {
    if (toneLoaded) return;
    try {
      const saved = window.localStorage.getItem(TONE_LS_KEY);
      if (saved !== null) setDefaultTone(saved === "1");
    } catch {
      /* localStorage blocked */
    }
    setToneLoaded(true);
  }, [toneLoaded]);

  // Persist tone preference.
  React.useEffect(() => {
    if (!toneLoaded) return;
    try {
      window.localStorage.setItem(TONE_LS_KEY, defaultTone ? "1" : "0");
    } catch {
      /* silent */
    }
  }, [defaultTone, toneLoaded]);

  // If count drops below the number of selected camera angles, trim.
  React.useEffect(() => {
    if (cameraAngles.length > count) {
      setCameraAngles((arr) => arr.slice(0, count));
    }
  }, [count, cameraAngles.length]);

  const generate = useMutation({
    mutationFn: () =>
      api.generateImagePrompts({
        scene: scene.trim(),
        personaDescriptor: persona.trim() || undefined,
        count,
        outfit: picks.outfit || undefined,
        shotType: picks.shotType || undefined,
        cameraQuality: picks.cameraQuality || undefined,
        photographer: picks.photographer || undefined,
        cameraAngles: cameraAngles.length > 0 ? cameraAngles : undefined,
        locale: picks.locale || undefined,
        lighting: picks.lighting || undefined,
        hairstyles: hairstyles.length > 0 ? hairstyles : undefined,
        defaultPersonality: defaultTone,
      }),
  });

  const prompts: string[] = generate.data ?? [];
  const canGenerate = scene.trim().length >= 2 && !generate.isPending;

  function togglePick(group: SingleOptionKey, value: string) {
    setPicks((p) => ({ ...p, [group]: p[group] === value ? "" : value }));
  }

  function toggleHairstyle(value: string) {
    setHairstyles((arr) =>
      arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
    );
  }

  function toggleCameraAngle(value: string) {
    setCameraAngles((arr) => {
      if (arr.includes(value)) return arr.filter((v) => v !== value);
      if (arr.length >= count) return arr; // capped at prompt count
      return [...arr, value];
    });
  }

  function clearAllPicks() {
    setPicks({});
    setHairstyles([]);
    setCameraAngles([]);
  }

  async function copy(text: string, i: number) {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  async function copyAll() {
    if (prompts.length === 0) return;
    try {
      await navigator.clipboard?.writeText(
        prompts.map((p, i) => `# Prompt ${i + 1}\n${p}`).join("\n\n")
      );
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  const totalPicks =
    Object.values(picks).filter((v) => v).length +
    (hairstyles.length > 0 ? 1 : 0) +
    (cameraAngles.length > 0 ? 1 : 0);
  const groupsCount = OPTION_GROUPS.length + 2; // +1 hairstyle +1 cameraAngles
  const personaPlaceholder =
    personaDefaultQ.data ?? "Loading default persona descriptor…";

  return (
    <div className="flex min-h-screen">
      <Sidebar onCompose={() => null} activeRoute="prompts" />

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
              <Camera className="h-5 w-5 text-[var(--accent)]" /> Image Prompts
            </h1>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              One scene + your director&apos;s notes → photoreal image-gen
              prompts with locked persona, EXIF specifics, skin-texture detail
              and lived-in environment. Paste each into your image generator.
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* ---------- Inputs ---------- */}
            <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              {/* Scene */}
              <div>
                <div className="mb-2 text-xs font-medium text-[var(--fg-muted)]">
                  Scene / vibe
                </div>
                <Textarea
                  value={scene}
                  onChange={(e) => setScene(e.target.value)}
                  placeholder="rooftop golden hour, candid laugh…"
                  className="min-h-[90px]"
                  maxLength={500}
                />
                <div className="mt-1 text-[11px] text-[var(--fg-subtle)]">
                  Or pick a preset:
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {SCENE_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setScene(p.value)}
                      className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--fg-muted)] transition-colors hover:text-fg"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Persona — collapsible */}
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)]">
                <button
                  type="button"
                  onClick={() => setPersonaOpen((v) => !v)}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-[var(--fg-muted)] hover:text-fg"
                >
                  <span className="flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5" />
                    Persona descriptor
                    <span className="rounded-full bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--fg-subtle)]">
                      {persona.trim() ? "custom" : "default"}
                    </span>
                  </span>
                  {personaOpen ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </button>
                {personaOpen && (
                  <div className="border-t border-[var(--border)] p-3">
                    <Textarea
                      value={persona}
                      onChange={(e) => setPersona(e.target.value)}
                      placeholder={personaPlaceholder}
                      className="min-h-[100px] text-xs"
                      maxLength={2000}
                    />
                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--fg-subtle)]">
                      <span>
                        Saved on this device. Empty = server default is used.
                      </span>
                      {persona.trim() && (
                        <button
                          type="button"
                          onClick={() => setPersona("")}
                          className="underline hover:text-fg"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Director's notes — chip groups */}
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-medium text-[var(--fg-muted)]">
                    Director&apos;s notes
                    <span className="rounded-full bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--fg-subtle)]">
                      {totalPicks}/{groupsCount} set
                    </span>
                  </div>
                  {totalPicks > 0 && (
                    <button
                      type="button"
                      onClick={clearAllPicks}
                      className="text-[11px] text-[var(--fg-muted)] underline hover:text-fg"
                    >
                      Clear all
                    </button>
                  )}
                </div>

                {optionsQ.isLoading ? (
                  <div className="flex items-center gap-2 text-[11px] text-[var(--fg-subtle)]">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading
                    options…
                  </div>
                ) : optionsQ.error || !optionsQ.data ? (
                  <div className="space-y-1.5 rounded border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-2 text-[11px] text-[var(--danger)]">
                    <div>Couldn&apos;t load options.</div>
                    <div className="text-[var(--fg-muted)]">
                      {(optionsQ.error as Error | undefined)?.message ??
                        "Empty response from /ai/image-prompts/options."}
                    </div>
                    <div className="text-[var(--fg-subtle)]">
                      Likely fix: restart the API dev server so the new route
                      registers.
                    </div>
                    <button
                      type="button"
                      onClick={() => optionsQ.refetch()}
                      className="underline text-[var(--fg)] hover:opacity-80"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {OPTION_GROUPS.map((g) => (
                      <ChipGroup
                        key={g.key}
                        label={g.label}
                        hint={g.hint}
                        options={optionsQ.data[g.key]}
                        value={picks[g.key] ?? ""}
                        onToggle={(v) => togglePick(g.key, v)}
                      />
                    ))}
                    <MultiChipGroup
                      label="Camera angle"
                      hint={
                        cameraAngles.length === 0
                          ? `pick up to ${count} — each prompt uses a different angle`
                          : cameraAngles.length === count
                            ? `${cameraAngles.length}/${count} — cap reached`
                            : `${cameraAngles.length}/${count} — one per prompt`
                      }
                      options={optionsQ.data.cameraAngle}
                      values={cameraAngles}
                      onToggle={toggleCameraAngle}
                      disabledForUnselected={cameraAngles.length >= count}
                    />
                    <MultiChipGroup
                      label="Hairstyle"
                      hint={
                        hairstyles.length > 1
                          ? `pool of ${hairstyles.length} — model picks ONE for the whole shoot`
                          : "pick any (or many — model picks one from the pool)"
                      }
                      options={optionsQ.data.hairstyle}
                      values={hairstyles}
                      onToggle={toggleHairstyle}
                    />
                  </div>
                )}
              </div>

              {/* Default tone toggle */}
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium">
                      Default personality
                    </div>
                    <div className="text-[11px] text-[var(--fg-muted)]">
                      Soft-flirty girlfriend register, body-flattering styling.
                      Off for editorial-only sets.
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={defaultTone}
                    onClick={() => setDefaultTone((v) => !v)}
                    className={cn(
                      "relative h-6 w-11 shrink-0 rounded-full border transition-colors",
                      defaultTone
                        ? "border-[var(--accent)] bg-[var(--accent)]"
                        : "border-[var(--border)] bg-[var(--surface)]"
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                        defaultTone ? "translate-x-[22px]" : "translate-x-0.5"
                      )}
                    />
                  </button>
                </div>
              </div>

              {/* Count */}
              <Segmented
                label="How many prompts"
                options={[
                  { value: "1", label: "1" },
                  { value: "3", label: "3" },
                  { value: "6", label: "6" },
                ]}
                value={String(count)}
                onChange={(v) => setCount(Number(v) as 1 | 3 | 6)}
              />

              <Button
                variant="accent"
                onClick={() => generate.mutate()}
                disabled={!canGenerate}
                className="w-full"
              >
                {generate.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
                Generate {count} prompt{count === 1 ? "" : "s"}
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
                  <Loader2 className="h-4 w-4 animate-spin" /> Composing the
                  shoot…
                </div>
              )}

              {!generate.isPending && prompts.length === 0 && (
                <div className="grid place-items-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
                  <Camera className="h-6 w-6 text-[var(--fg-subtle)]" />
                  <div className="mt-2 text-sm font-medium">
                    Your prompts will appear here
                  </div>
                  <div className="mt-1 text-xs text-[var(--fg-muted)]">
                    Add a scene on the left and hit Generate.
                  </div>
                </div>
              )}

              {prompts.length > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
                  <span className="text-xs text-[var(--fg-muted)]">
                    {prompts.length} prompt{prompts.length === 1 ? "" : "s"} ·
                    same shoot, different frames
                  </span>
                  <Button variant="soft" size="sm" onClick={copyAll}>
                    {copiedAll ? (
                      <>
                        <Check className="h-3.5 w-3.5" /> Copied all
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" /> Copy all
                      </>
                    )}
                  </Button>
                </div>
              )}

              {prompts.map((p, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wider text-[var(--fg-subtle)]">
                      Prompt {i + 1}
                    </span>
                    <span className="text-[11px] text-[var(--fg-subtle)]">
                      {wordCount(p)} words
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed text-fg">
                    {p}
                  </div>
                  <div className="mt-3 flex items-center justify-end">
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={() => copy(p, i)}
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

function ChipGroup(props: {
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onToggle: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-[var(--fg-muted)]">
          {props.label}
        </span>
        {props.hint && (
          <span className="text-[10px] text-[var(--fg-subtle)]">
            {props.hint}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {props.options.map((o) => {
          const active = props.value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => props.onToggle(o.value)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                active
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] hover:text-fg"
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

function MultiChipGroup(props: {
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
  values: string[];
  onToggle: (v: string) => void;
  disabledForUnselected?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-[var(--fg-muted)]">
          {props.label}
        </span>
        {props.hint && (
          <span className="text-[10px] text-[var(--fg-subtle)]">
            {props.hint}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {props.options.map((o) => {
          const active = props.values.includes(o.value);
          const disabled = !active && !!props.disabledForUnselected;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => props.onToggle(o.value)}
              disabled={disabled}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                active
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : disabled
                    ? "border-[var(--border)] bg-[var(--surface)] text-[var(--fg-subtle)] opacity-50 cursor-not-allowed"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] hover:text-fg"
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

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
