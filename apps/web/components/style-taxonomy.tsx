"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, EyeOff, Loader2, Plus, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import type { StyleOptionRow } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The visual taxonomy — outfits, locales, lighting, and any axis you add.
// `dimension` is a free string on the server, so a new axis is created by
// naming one here, not by shipping a migration.

const DIMENSION_LABELS: Record<string, string> = {
  outfit: "Outfit",
  shotType: "Shot type",
  cameraQuality: "Camera",
  photographer: "Photographer",
  cameraAngle: "Camera angle",
  locale: "Locale",
  lighting: "Lighting",
  hairstyle: "Hairstyle",
};

const niceName = (d: string) =>
  DIMENSION_LABELS[d] ?? d.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

export function StyleTaxonomy() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["style-options"], queryFn: api.getStyleOptions });
  const [openDim, setOpenDim] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["style-options"] });
    void qc.invalidateQueries({ queryKey: ["image-prompt-options"] });
  };
  const onError = (e: Error) => setError(e.message);

  const update = useMutation({
    mutationFn: (v: { id: string; patch: Parameters<typeof api.updateStyleOption>[1] }) =>
      api.updateStyleOption(v.id, v.patch),
    onSuccess: invalidate,
    onError,
  });
  const disable = useMutation({
    mutationFn: (id: string) => api.disableStyleOption(id),
    onSuccess: invalidate,
    onError,
  });
  const restore = useMutation({
    mutationFn: (dimension: string) => api.restoreStyleDefaults(dimension),
    onSuccess: invalidate,
    onError,
  });
  const create = useMutation({
    mutationFn: api.createStyleOption,
    onSuccess: invalidate,
    onError,
  });

  if (!q.data) {
    return (
      <Card>
        <p className="text-xs text-[var(--fg-muted)]">
          {q.isError ? "Style options unavailable." : "Loading…"}
        </p>
      </Card>
    );
  }

  const dims = q.data.dimensions;

  return (
    <Card>
      <div>
        <h2 className="text-sm font-semibold">Visual style</h2>
        <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
          What the image-prompt writer can draw from. Disabling an option hides it
          from the picker but keeps old drafts that reference it readable.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {dims.map((dim) => {
          const rows = q.data.byDimension[dim] ?? [];
          const live = rows.filter((r) => r.enabled).length;
          const isOpen = openDim === dim;
          return (
            <div key={dim} className="rounded-lg border border-[var(--border)]">
              <button
                onClick={() => setOpenDim(isOpen ? null : dim)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs"
              >
                <span className="font-medium">{niceName(dim)}</span>
                <span className="text-[10px] text-[var(--fg-subtle)]">
                  {live} active
                  {rows.length > live ? ` · ${rows.length - live} hidden` : ""}
                </span>
              </button>

              {isOpen && (
                <div className="space-y-2 border-t border-[var(--border)] p-3">
                  {rows.map((row) => (
                    <OptionRow
                      key={row.id}
                      row={row}
                      pending={
                        (update.isPending && update.variables?.id === row.id) ||
                        (disable.isPending && disable.variables === row.id)
                      }
                      onSave={(patch) => update.mutate({ id: row.id, patch })}
                      onDisable={() => disable.mutate(row.id)}
                    />
                  ))}

                  <NewOption
                    dimension={dim}
                    pending={create.isPending}
                    onCreate={(body) => create.mutate(body)}
                  />

                  <button
                    onClick={() => restore.mutate(dim)}
                    disabled={restore.isPending}
                    className="flex items-center gap-1 text-[10px] text-[var(--fg-subtle)] hover:underline"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restore any missing built-in options (never overwrites edits)
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <NewDimension
        pending={create.isPending}
        existing={dims}
        onCreate={(body) => {
          create.mutate(body, { onSuccess: () => setOpenDim(body.dimension) });
        }}
      />
    </Card>
  );
}

function OptionRow(props: {
  row: StyleOptionRow;
  pending: boolean;
  onSave: (patch: { label?: string; promptText?: string; enabled?: boolean }) => void;
  onDisable: () => void;
}) {
  const { row } = props;
  const [label, setLabel] = React.useState(row.label);
  const [text, setText] = React.useState(row.promptText);
  const dirty = label !== row.label || text !== row.promptText;

  React.useEffect(() => {
    setLabel(row.label);
    setText(row.promptText);
  }, [row.label, row.promptText]);

  return (
    <div
      className={`space-y-1.5 rounded-md border border-[var(--border)] p-2 ${
        row.enabled ? "" : "opacity-50"
      }`}
    >
      <div className="flex items-center gap-2">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="h-7 flex-1 text-xs"
        />
        <code className="shrink-0 text-[10px] text-[var(--fg-subtle)]">{row.key}</code>
        {row.enabled ? (
          <Button variant="soft" size="sm" onClick={props.onDisable} title="Hide from the picker">
            <EyeOff className="h-3 w-3" />
          </Button>
        ) : (
          <Button variant="soft" size="sm" onClick={() => props.onSave({ enabled: true })}>
            Re-enable
          </Button>
        )}
      </div>
      <textarea
        rows={3}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-2 font-mono text-[10px] leading-relaxed outline-none focus:border-[var(--accent)]"
      />
      {dirty && (
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={props.pending}
            onClick={() => props.onSave({ label, promptText: text })}
          >
            {props.pending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Check className="mr-1 h-3 w-3" />
            )}
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function NewOption(props: {
  dimension: string;
  pending: boolean;
  onCreate: (b: { dimension: string; key: string; label: string; promptText: string }) => void;
}) {
  const [label, setLabel] = React.useState("");
  const [text, setText] = React.useState("");
  // Keys are stable slugs referenced by saved drafts, so derive one rather than
  // asking for it — and never reuse one for a new meaning.
  const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const ready = key.length > 0 && text.trim().length > 0;

  return (
    <div className="space-y-1.5 rounded-md border border-dashed border-[var(--border)] p-2">
      <Input
        placeholder="New option label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="h-7 text-xs"
      />
      <textarea
        rows={2}
        spellCheck={false}
        placeholder="Photography direction fed to the model, e.g. “fitted linen shirt, sleeves rolled, salt in the hair”"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-2 font-mono text-[10px] outline-none focus:border-[var(--accent)]"
      />
      <div className="flex items-center justify-between">
        <code className="text-[10px] text-[var(--fg-subtle)]">{key || "—"}</code>
        <Button
          size="sm"
          disabled={!ready || props.pending}
          onClick={() => {
            props.onCreate({ dimension: props.dimension, key, label: label.trim(), promptText: text.trim() });
            setLabel("");
            setText("");
          }}
        >
          <Plus className="mr-1 h-3 w-3" />
          Add
        </Button>
      </div>
    </div>
  );
}

function NewDimension(props: {
  pending: boolean;
  existing: string[];
  onCreate: (b: { dimension: string; key: string; label: string; promptText: string }) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [text, setText] = React.useState("");
  const dimension = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const clash = props.existing.includes(dimension);
  const ready = dimension.length > 0 && key.length > 0 && text.trim().length > 0 && !clash;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-[11px] text-[var(--fg-muted)] hover:underline"
      >
        <Plus className="h-3 w-3" />
        Add a new axis (prop, season, mood — anything)
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-[var(--border)] p-3">
      <p className="text-[10px] text-[var(--fg-subtle)]">
        A new axis needs one option to exist. The generator places any axis it
        finds; nothing here is compiled in.
      </p>
      <Input placeholder="Axis name, e.g. Season" value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-xs" />
      <Input placeholder="First option label, e.g. Monsoon" value={label} onChange={(e) => setLabel(e.target.value)} className="h-7 text-xs" />
      <textarea
        rows={2}
        spellCheck={false}
        placeholder="Direction for that option"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-2 font-mono text-[10px] outline-none focus:border-[var(--accent)]"
      />
      {clash && (
        <p className="text-[10px] text-amber-500">“{dimension}” already exists.</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="soft" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!ready || props.pending}
          onClick={() => {
            props.onCreate({ dimension, key, label: label.trim(), promptText: text.trim() });
            setName("");
            setLabel("");
            setText("");
            setOpen(false);
          }}
        >
          Create axis
        </Button>
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      {children}
    </div>
  );
}
