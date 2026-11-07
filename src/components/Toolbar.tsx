"use client";

import { useRef, useState } from "react";

import { PROVIDERS, PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";
import type { Settings } from "@/lib/settings";

type Props = {
  settings: Settings;
  onChange: (next: Settings) => void;
  onConvert: (file: File) => void;
  onExample: () => void;
  busy: boolean;
  status: { kind: "idle" | "ok" | "error"; text: string };
};

export function Toolbar({ settings, onChange, onConvert, onExample, busy, status }: Props) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const spec = PROVIDERS[settings.provider];

  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3">
      <div className="pointer-events-auto w-full max-w-2xl rounded-xl border border-black/10 bg-white/95 shadow-sm backdrop-blur">
        <div className="flex items-center gap-2 p-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="rounded-lg bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Retracing…" : "Retrace a sketch"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onConvert(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={onExample}
            disabled={busy}
            className="rounded-lg border border-black/10 px-2.5 py-2 text-sm disabled:opacity-40"
          >
            Example
          </button>
          <span className="truncate text-xs opacity-60">
            {status.kind === "idle"
              ? "Draw or photograph a diagram — get real, editable shapes back."
              : status.text}
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto shrink-0 rounded-lg border border-black/10 px-2.5 py-1.5 text-xs"
          >
            {spec.label}
          </button>
        </div>

        {open && (
          <div className="grid gap-2 border-t border-black/10 p-3 text-xs sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="opacity-60">Provider</span>
              <select
                value={settings.provider}
                onChange={(e) =>
                  set({ provider: e.target.value as ProviderId, model: "", baseUrl: "" })
                }
                className="rounded border border-black/15 px-2 py-1.5"
              >
                {PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {PROVIDERS[id].label}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1">
              <span className="opacity-60">
                Model{spec.defaultModel ? ` (default ${spec.defaultModel})` : " (required)"}
              </span>
              <input
                value={settings.model}
                placeholder={spec.defaultModel ?? "e.g. llama3.2-vision"}
                onChange={(e) => set({ model: e.target.value })}
                className="rounded border border-black/15 px-2 py-1.5"
              />
            </label>

            <label className="grid gap-1">
              <span className="opacity-60">API key — stays in this browser</span>
              <input
                type="password"
                autoComplete="off"
                value={settings.keys[settings.provider] ?? ""}
                placeholder={spec.keyHint}
                onChange={(e) =>
                  set({ keys: { ...settings.keys, [settings.provider]: e.target.value } })
                }
                className="rounded border border-black/15 px-2 py-1.5 font-mono"
              />
            </label>

            <label className="grid gap-1">
              <span className="opacity-60">
                Base URL{spec.requiresBaseUrl ? " (required)" : " (optional)"}
              </span>
              <input
                value={settings.baseUrl}
                placeholder={spec.defaultBaseUrl ?? "https://your-endpoint/v1"}
                onChange={(e) => set({ baseUrl: e.target.value })}
                className="rounded border border-black/15 px-2 py-1.5 font-mono"
              />
            </label>

            <p className="sm:col-span-2 opacity-60">
              Get a key:{" "}
              <a className="underline" href={spec.docsUrl} target="_blank" rel="noreferrer">
                {spec.docsUrl}
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
