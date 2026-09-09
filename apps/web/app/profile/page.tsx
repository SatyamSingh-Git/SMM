"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Eye, Loader2, Check } from "lucide-react";
import { api } from "@/lib/api";
import type {
  ProfileIdentity,
  ProfilePatch,
  ProfileView,
  VoiceTask,
} from "@/lib/types";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Everything the account IS — handle, voice, look — lives here rather than in
// the code. Editing a voice block changes what gets published, so each section
// saves on its own and every save snapshots the previous state.

const VOICE_BLOCKS: Array<{ task: VoiceTask; title: string; subtitle: string }> = [
  {
    task: "reply",
    title: "Reply voice",
    subtitle:
      "The auto-reply agent. This one publishes unattended — the highest-stakes block on the page.",
  },
  {
    task: "caption",
    title: "Caption voice",
    subtitle: "Captions, /inspire, and the carousel companion writer.",
  },
  {
    task: "dashboardStrategist",
    title: "Dashboard — strategist",
    subtitle: "Weekly focus and actions.",
  },
  {
    task: "dashboardCaptionAnalyst",
    title: "Dashboard — caption analyst",
    subtitle: "What separates top from bottom posts.",
  },
  {
    task: "dashboardCommentAnalyst",
    title: "Dashboard — comment analyst",
    subtitle: "Audience themes.",
  },
];

type Section = "identity" | "visual" | VoiceTask;

export default function ProfilePage() {
  const qc = useQueryClient();
  const healthQ = useQuery({ queryKey: ["health"], queryFn: api.health });
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const profileQ = useQuery({ queryKey: ["profile"], queryFn: api.getProfile });
  const versionsQ = useQuery({
    queryKey: ["profile-versions"],
    queryFn: api.profileVersions,
  });

  const [draft, setDraft] = React.useState<ProfileView | null>(null);
  const [savedSection, setSavedSection] = React.useState<Section | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (profileQ.data) setDraft(profileQ.data);
  }, [profileQ.data]);

  const save = useMutation({
    mutationFn: (vars: { section: Section; patch: ProfilePatch }) =>
      api.updateProfile(vars.patch),
    onSuccess: (updated, vars) => {
      setError(null);
      setDraft(updated);
      qc.setQueryData(["profile"], updated);
      void qc.invalidateQueries({ queryKey: ["profile-versions"] });
      setSavedSection(vars.section);
      setTimeout(
        () => setSavedSection((s) => (s === vars.section ? null : s)),
        2500
      );
    },
    onError: (e: Error) => setError(e.message),
  });

  const rollback = useMutation({
    mutationFn: (version: number) => api.rollbackProfile(version),
    onSuccess: (updated) => {
      setDraft(updated);
      qc.setQueryData(["profile"], updated);
      void qc.invalidateQueries({ queryKey: ["profile-versions"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const pending = save.isPending ? (save.variables?.section ?? null) : null;

  if (!draft) {
    return (
      <Shell accounts={accountsQ.data ?? []} health={healthQ.data} version={null}>
        <div className="text-sm text-[var(--fg-muted)]">
          {profileQ.isError
            ? "Profile not available. If this is a fresh database, restart the API so it seeds."
            : "Loading…"}
        </div>
      </Shell>
    );
  }

  const setIdentity = (k: keyof ProfileIdentity, v: string | string[]) =>
    setDraft({ ...draft, identity: { ...draft.identity, [k]: v } });

  return (
    <Shell
      accounts={accountsQ.data ?? []}
      health={healthQ.data}
      version={draft.version}
    >
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {error}
        </div>
      )}

      <SectionCard
        title="Identity"
        subtitle="Substituted into every prompt via {{placeholders}}. Changing the handle updates all of them at once."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Handle (no @)" value={draft.identity.handle}
            onChange={(v) => setIdentity("handle", v)} />
          <Field label="Display name" value={draft.identity.displayName}
            onChange={(v) => setIdentity("displayName", v)} />
          <Field label="Pronouns" value={draft.identity.pronouns}
            onChange={(v) => setIdentity("pronouns", v)} />
          <Field label="Age band" value={draft.identity.ageBand}
            onChange={(v) => setIdentity("ageBand", v)} />
          <Field label="Nationality" value={draft.identity.nationality}
            onChange={(v) => setIdentity("nationality", v)} />
          <Field label="Locale" value={draft.identity.locale}
            onChange={(v) => setIdentity("locale", v)} />
          <Field
            label="Languages (comma separated)"
            value={draft.identity.languages.join(", ")}
            onChange={(v) =>
              setIdentity(
                "languages",
                v.split(",").map((x) => x.trim()).filter(Boolean)
              )
            }
          />
          <Field label="Niche" value={draft.identity.niche}
            onChange={(v) => setIdentity("niche", v)} />
        </div>
        <Field label="Audience" value={draft.identity.audience}
          onChange={(v) => setIdentity("audience", v)} />
        <SaveRow
          pending={pending === "identity"}
          saved={savedSection === "identity"}
          onSave={() =>
            save.mutate({ section: "identity", patch: { identity: draft.identity } })
          }
        />
      </SectionCard>

      {VOICE_BLOCKS.map(({ task, title, subtitle }) => (
        <VoiceCard
          key={task}
          title={title}
          subtitle={subtitle}
          value={draft.voice[task]}
          task={task}
          identity={draft.identity}
          pending={pending === task}
          saved={savedSection === task}
          onChange={(v) =>
            setDraft({ ...draft, voice: { ...draft.voice, [task]: v } })
          }
          onSave={() =>
            save.mutate({ section: task, patch: { voice: { [task]: draft.voice[task] } } })
          }
        />
      ))}

      <SectionCard
        title="Subject descriptor"
        subtitle="Reproduced verbatim at the head of every generated image prompt. Image models lock identity on exact-token repetition, so edit it as a whole rather than paraphrasing."
      >
        <TextArea
          rows={8}
          value={draft.visual.subjectDescriptor}
          onChange={(v) =>
            setDraft({ ...draft, visual: { ...draft.visual, subjectDescriptor: v } })
          }
        />
        <SaveRow
          pending={pending === "visual"}
          saved={savedSection === "visual"}
          onSave={() =>
            save.mutate({ section: "visual", patch: { visual: draft.visual } })
          }
        />
      </SectionCard>

      <SectionCard
        title="History"
        subtitle="Every save snapshots the previous state. Rolling back writes a new version — it never rewrites history."
      >
        {(versionsQ.data ?? []).length === 0 ? (
          <p className="text-xs text-[var(--fg-muted)]">No edits yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] text-xs">
            {(versionsQ.data ?? []).map((v) => (
              <li key={v.version} className="flex items-center gap-3 py-2">
                <span className="font-mono text-[var(--fg-muted)]">v{v.version}</span>
                <span className="flex-1 truncate text-[var(--fg-subtle)]">
                  {v.note ?? "—"}
                </span>
                <span className="text-[10px] text-[var(--fg-subtle)]">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
                <Button
                  variant="soft"
                  size="sm"
                  disabled={rollback.isPending}
                  onClick={() => rollback.mutate(v.version)}
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </Shell>
  );
}

function VoiceCard(props: {
  title: string;
  subtitle: string;
  value: string;
  task: VoiceTask;
  identity: ProfileIdentity;
  pending: boolean;
  saved: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const [preview, setPreview] = React.useState<string | null>(null);
  const previewM = useMutation({
    mutationFn: () =>
      api.previewPrompt({
        task: props.task,
        voice: props.value,
        identity: props.identity,
      }),
    onSuccess: (r) => setPreview(r.composed),
  });

  return (
    <SectionCard title={props.title} subtitle={props.subtitle}>
      <TextArea rows={12} value={props.value} onChange={props.onChange} />
      <div className="flex items-center gap-2 text-[10px] text-[var(--fg-subtle)]">
        <span>{props.value.length.toLocaleString()} chars</span>
        <span>·</span>
        <Button
          variant="soft"
          size="sm"
          disabled={previewM.isPending}
          onClick={() => (preview ? setPreview(null) : previewM.mutate())}
        >
          <Eye className="mr-1 h-3 w-3" />
          {preview ? "Hide" : "Preview as the model sees it"}
        </Button>
      </div>
      {preview !== null && (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[11px] leading-relaxed">
          {preview}
        </pre>
      )}
      <SaveRow
        pending={props.pending}
        saved={props.saved}
        onSave={props.onSave}
        note="Saving resets the prompt cache — the next few AI calls cost more on input tokens."
      />
    </SectionCard>
  );
}

function SaveRow(props: {
  pending: boolean;
  saved: boolean;
  onSave: () => void;
  note?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3">
      <span className="text-[10px] text-[var(--fg-subtle)]">
        {props.saved ? (
          <span className="inline-flex items-center gap-1 text-emerald-500">
            <Check className="h-3 w-3" /> Saved
          </span>
        ) : (
          props.note ?? ""
        )}
      </span>
      <Button size="sm" disabled={props.pending} onClick={props.onSave}>
        {props.pending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        Save
      </Button>
    </div>
  );
}

function Shell({
  accounts,
  health,
  version,
  children,
}: {
  accounts: { username: string | null }[];
  health?: { killSwitch?: boolean };
  version: number | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar onCompose={() => null} activeRoute="profile" />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar
          onCompose={() => null}
          username={accounts[0]?.username ?? null}
          killSwitch={health?.killSwitch}
        />
        <main className="flex-1 min-w-0 space-y-5 p-4 max-w-3xl lg:p-6">
          <div>
            <h1 className="text-lg font-semibold">Persona</h1>
            <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
              Who this account is. Nothing here is compiled in — every prompt the
              system sends is built from these fields.
              {version !== null && ` Currently on v${version}.`}
            </p>
          </div>
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
          <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">{props.subtitle}</p>
        )}
      </div>
      {props.children}
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-[var(--fg-muted)]">
        {props.label}
      </label>
      <Input
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1"
      />
    </div>
  );
}

function TextArea(props: {
  rows: number;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      rows={props.rows}
      spellCheck={false}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-[11px] leading-relaxed outline-none focus:border-[var(--accent)]"
    />
  );
}
