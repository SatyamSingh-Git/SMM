"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Save, Settings as SettingsIcon } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { ConnectionBanner } from "@/components/connection-banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { AppSettingsView, AppSettingsPatch } from "@/lib/types";
import { cn } from "@/lib/utils";

// Mirror of the server-side feasibility check (routes/settings.ts) for a live
// client-side warning before the user even hits Save.
const MORNING_LEN = (11 - 6) * 60;
const EVENING_LEN = (24 - 16) * 60;
const MIN_ACTIVE = 20;
function fits(count: number, min: number, len: number): boolean {
  if (count <= 0) return true;
  return count * min + (count + 1) * MIN_ACTIVE <= len;
}
function sleepTotal(count: number, min: number): number {
  return Math.max(0, count) * min;
}

type Form = {
  dailyReplyCap: number;
  perPostReplyCap: number;
  morningSleepCount: number;
  morningSleepMin: number;
  eveningSleepCount: number;
  eveningSleepMin: number;
  deepseekModel: string;
  visionModel: string;
  killSwitch: boolean;
  autoReplyEnabled: boolean;
};

function toForm(v: AppSettingsView): Form {
  return {
    dailyReplyCap: v.dailyReplyCap,
    perPostReplyCap: v.perPostReplyCap,
    morningSleepCount: v.morningSleepCount,
    morningSleepMin: v.morningSleepMin,
    eveningSleepCount: v.eveningSleepCount,
    eveningSleepMin: v.eveningSleepMin,
    deepseekModel: v.deepseekModel,
    visionModel: v.visionModel,
    killSwitch: v.killSwitch,
    autoReplyEnabled: v.autoReplyEnabled,
  };
}

type Section = "limits" | "sleep" | "ai" | "controls";

export default function SettingsPage() {
  const qc = useQueryClient();
  const healthQ = useQuery({ queryKey: ["health"], queryFn: api.health });
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const settingsQ = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });

  const [form, setForm] = React.useState<Form | null>(null);
  const [deepseekKey, setDeepseekKey] = React.useState("");
  const [openrouterKey, setOpenrouterKey] = React.useState("");
  const [savedSection, setSavedSection] = React.useState<Section | null>(null);

  React.useEffect(() => {
    if (settingsQ.data && !form) setForm(toForm(settingsQ.data));
  }, [settingsQ.data, form]);

  // One mutation per section so each Save is independent. `section` is passed
  // through the mutation variables so onSuccess can flag the right section.
  const save = useMutation({
    mutationFn: (vars: { section: Section; patch: AppSettingsPatch }) =>
      api.updateSettings(vars.patch),
    onSuccess: (v, vars) => {
      setForm(toForm(v));
      // Only clear the key inputs that this save consumed.
      if (vars.section === "ai") {
        setDeepseekKey("");
        setOpenrouterKey("");
      }
      setSavedSection(vars.section);
      setTimeout(
        () => setSavedSection((s) => (s === vars.section ? null : s)),
        2500
      );
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["health"] });
      qc.invalidateQueries({ queryKey: ["engagement", "stats"] });
    },
  });
  const pendingSection =
    save.isPending && save.variables ? save.variables.section : null;

  if (!form) {
    return (
      <Shell accounts={accountsQ.data ?? []} health={healthQ.data}>
        <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
        </div>
      </Shell>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const morningOk = fits(form.morningSleepCount, form.morningSleepMin, MORNING_LEN);
  const eveningOk = fits(form.eveningSleepCount, form.eveningSleepMin, EVENING_LEN);

  const v = settingsQ.data!;

  function saveSection(section: Section) {
    if (!form) return;
    let patch: AppSettingsPatch;
    if (section === "limits") {
      patch = {
        dailyReplyCap: form.dailyReplyCap,
        perPostReplyCap: form.perPostReplyCap,
      };
    } else if (section === "sleep") {
      patch = {
        morningSleepCount: form.morningSleepCount,
        morningSleepMin: form.morningSleepMin,
        eveningSleepCount: form.eveningSleepCount,
        eveningSleepMin: form.eveningSleepMin,
      };
    } else if (section === "ai") {
      patch = {
        deepseekModel: form.deepseekModel,
        visionModel: form.visionModel,
        ...(deepseekKey.trim() ? { deepseekApiKey: deepseekKey.trim() } : {}),
        ...(openrouterKey.trim() ? { openrouterApiKey: openrouterKey.trim() } : {}),
      };
    } else {
      patch = {
        killSwitch: form.killSwitch,
        autoReplyEnabled: form.autoReplyEnabled,
      };
    }
    save.mutate({ section, patch });
  }

  const saveRow = (section: Section, disabled = false) => (
    <SaveRow
      pending={pendingSection === section}
      saved={savedSection === section}
      error={
        save.isError && save.variables?.section === section
          ? (save.error as Error).message
          : null
      }
      disabled={disabled}
      onSave={() => saveSection(section)}
    />
  );

  return (
    <Shell accounts={accountsQ.data ?? []} health={healthQ.data}>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <SettingsIcon className="h-5 w-5 text-[var(--accent)]" /> Settings
        </h1>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          Each section saves on its own. Caps + toggles apply immediately;
          sleep-window changes apply to the next day&apos;s schedule (the current
          day is already locked).
        </p>
      </div>

      {/* Reply limits */}
      <SectionCard title="Reply limits" subtitle="Per IST day.">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Daily reply cap"
            hint="Max auto-replies across all posts per day."
            value={form.dailyReplyCap}
            min={1}
            max={2000}
            onChange={(n) => set("dailyReplyCap", n)}
          />
          <NumberField
            label="Per-post reply cap"
            hint="Max auto-replies to any single post per day."
            value={form.perPostReplyCap}
            min={1}
            max={1000}
            onChange={(n) => set("perPostReplyCap", n)}
          />
        </div>
        {saveRow("limits")}
      </SectionCard>

      {/* Sleep windows */}
      <SectionCard
        title="Sleep windows"
        subtitle="Random micro-breaks the agent takes inside each active session. Times are computed once overnight and frozen for the day."
      >
        <SleepSession
          label={`Morning session · ${v.morningBand}`}
          count={form.morningSleepCount}
          min={form.morningSleepMin}
          sessionLen={MORNING_LEN}
          ok={morningOk}
          onCount={(n) => set("morningSleepCount", n)}
          onMin={(n) => set("morningSleepMin", n)}
        />
        <SleepSession
          label={`Evening session · ${v.eveningBand}`}
          count={form.eveningSleepCount}
          min={form.eveningSleepMin}
          sessionLen={EVENING_LEN}
          ok={eveningOk}
          onCount={(n) => set("eveningSleepCount", n)}
          onMin={(n) => set("eveningSleepMin", n)}
        />
        {saveRow("sleep", !morningOk || !eveningOk)}
      </SectionCard>

      {/* AI providers */}
      <SectionCard
        title="AI providers"
        subtitle="Leave a key blank to keep the current one. DeepSeek powers text; OpenRouter powers image vision."
      >
        {/* Dummy hidden fields absorb the browser's autofill so it doesn't
            dump a saved email/password into the model + key inputs. */}
        <input type="text" name="username" autoComplete="username" className="hidden" tabIndex={-1} aria-hidden />
        <input type="password" name="password" autoComplete="current-password" className="hidden" tabIndex={-1} aria-hidden />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="DeepSeek model"
            name="smm-deepseek-model"
            value={form.deepseekModel}
            placeholder={v.deepseekModelEffective}
            onChange={(s) => set("deepseekModel", s)}
          />
          <TextField
            label="Vision model (OpenRouter)"
            name="smm-vision-model"
            value={form.visionModel}
            placeholder={v.visionModelEffective}
            onChange={(s) => set("visionModel", s)}
          />
          <KeyField
            label="DeepSeek API key"
            name="smm-deepseek-key"
            configured={v.deepseekApiKeyConfigured}
            last4={v.deepseekApiKeyLast4}
            value={deepseekKey}
            onChange={setDeepseekKey}
            onResetToEnv={() =>
              save.mutate({ section: "ai", patch: { deepseekApiKey: "" } })
            }
          />
          <KeyField
            label="OpenRouter API key"
            name="smm-openrouter-key"
            configured={v.openrouterApiKeyConfigured}
            last4={v.openrouterApiKeyLast4}
            value={openrouterKey}
            onChange={setOpenrouterKey}
            onResetToEnv={() =>
              save.mutate({ section: "ai", patch: { openrouterApiKey: "" } })
            }
          />
        </div>
        {saveRow("ai")}
      </SectionCard>

      {/* Controls */}
      <SectionCard title="Controls" subtitle="Live operational switches.">
        <Toggle
          label="Kill switch"
          hint="Pause ALL publishing and auto-replies instantly."
          danger
          checked={form.killSwitch}
          onChange={(b) => set("killSwitch", b)}
        />
        <Toggle
          label="Auto-reply enabled"
          hint="When off, no comments get auto-replies (publishing unaffected)."
          checked={form.autoReplyEnabled}
          onChange={(b) => set("autoReplyEnabled", b)}
        />
        {saveRow("controls")}
      </SectionCard>
    </Shell>
  );
}

function SaveRow(props: {
  pending: boolean;
  saved: boolean;
  error: string | null;
  disabled?: boolean;
  onSave: () => void;
}) {
  return (
    <div className="mt-1 flex items-center justify-end gap-3 border-t border-[var(--border)] pt-3">
      {props.error && (
        <span className="text-[11px] text-[var(--danger)]">{props.error}</span>
      )}
      {props.saved && (
        <span className="flex items-center gap-1 text-[11px] text-[var(--success)]">
          <Check className="h-3.5 w-3.5" /> Saved
        </span>
      )}
      <Button
        variant="accent"
        size="sm"
        onClick={props.onSave}
        disabled={props.pending || props.disabled}
      >
        {props.pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Save className="h-3.5 w-3.5" />
        )}
        Save
      </Button>
    </div>
  );
}

function Shell({
  accounts,
  health,
  children,
}: {
  accounts: { username: string | null }[];
  health?: { killSwitch?: boolean };
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar onCompose={() => null} activeRoute="settings" />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar
          onCompose={() => null}
          username={accounts[0]?.username ?? null}
          killSwitch={health?.killSwitch}
        />
        <main className="flex-1 min-w-0 p-4 lg:p-6 space-y-5 max-w-3xl">
          <ConnectionBanner errors={[]} />
          {children}
        </main>
      </div>
    </div>
  );
}

function SectionCard(props: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div>
        <h2 className="text-sm font-semibold">{props.title}</h2>
        {props.subtitle && (
          <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
            {props.subtitle}
          </p>
        )}
      </div>
      {props.children}
    </div>
  );
}

function NumberField(props: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-[var(--fg-muted)]">
        {props.label}
      </label>
      <Input
        type="number"
        min={props.min}
        max={props.max}
        value={Number.isFinite(props.value) ? props.value : ""}
        onChange={(e) => props.onChange(parseInt(e.target.value || "0", 10))}
        className="mt-1"
      />
      {props.hint && (
        <div className="mt-1 text-[10px] text-[var(--fg-subtle)]">{props.hint}</div>
      )}
    </div>
  );
}

function TextField(props: {
  label: string;
  name: string;
  value: string;
  placeholder?: string;
  onChange: (s: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-[var(--fg-muted)]">
        {props.label}
      </label>
      <Input
        name={props.name}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1"
      />
    </div>
  );
}

function KeyField(props: {
  label: string;
  name: string;
  configured: boolean;
  last4: string | null;
  value: string;
  onChange: (s: string) => void;
  onResetToEnv: () => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-[var(--fg-muted)]">
        {props.label}
      </label>
      <Input
        type="password"
        name={props.name}
        autoComplete="new-password"
        autoCorrect="off"
        spellCheck={false}
        value={props.value}
        placeholder={
          props.configured ? `configured ••••${props.last4 ?? ""}` : "not set"
        }
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1"
      />
      <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--fg-subtle)]">
        <span>Stored encrypted. Blank = keep current.</span>
        <button
          type="button"
          onClick={props.onResetToEnv}
          className="underline hover:text-fg"
        >
          Reset to env default
        </button>
      </div>
    </div>
  );
}

function SleepSession(props: {
  label: string;
  count: number;
  min: number;
  sessionLen: number;
  ok: boolean;
  onCount: (n: number) => void;
  onMin: (n: number) => void;
}) {
  const sleepH = (sleepTotal(props.count, props.min) / 60).toFixed(1);
  const activeH = ((props.sessionLen - sleepTotal(props.count, props.min)) / 60).toFixed(1);
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="mb-2 text-xs font-medium">{props.label}</div>
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Number of sleeps"
          value={props.count}
          min={0}
          max={10}
          onChange={props.onCount}
        />
        <NumberField
          label="Minutes each"
          value={props.min}
          min={0}
          max={240}
          onChange={props.onMin}
        />
      </div>
      <div className="mt-2 text-[10px]">
        {props.ok ? (
          <span className="text-[var(--fg-subtle)]">
            ≈ {sleepH}h asleep / {activeH}h active this session
          </span>
        ) : (
          <span className="text-[var(--danger)]">
            Doesn&apos;t fit — reduce count or minutes (need ≥{MIN_ACTIVE}min
            active between each).
          </span>
        )}
      </div>
    </div>
  );
}

function Toggle(props: {
  label: string;
  hint?: string;
  checked: boolean;
  danger?: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-xs font-medium">{props.label}</div>
        {props.hint && (
          <div className="text-[10px] text-[var(--fg-muted)]">{props.hint}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        onClick={() => props.onChange(!props.checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full border transition-colors",
          props.checked
            ? props.danger
              ? "border-[var(--danger)] bg-[var(--danger)]"
              : "border-[var(--accent)] bg-[var(--accent)]"
            : "border-[var(--border)] bg-[var(--surface)]"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
            props.checked ? "translate-x-[22px]" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}
