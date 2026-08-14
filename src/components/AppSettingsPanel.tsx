// App-level settings, in the right-side slot: credentials shared by all
// bots. Per-bot settings (name, persona, model, computer)
// live in SettingsPanel; contextual Box-token entry stays in ComputerPanel.
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";


/** Launch-at-login — desktop shell only; default off. */
function LaunchAtLoginRow() {
  const login = window.ogb?.loginItem;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!login) return;
    void login.get().then((enabled) => setOn(enabled === true));
  }, [login]);
  if (!login) return null;
  return (
    <div className="mt-4 flex items-center justify-between gap-4 rounded-xl bg-card p-4">
      <div>
        <div className="text-[15px] font-medium text-ink">Launch at login</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          Open VelarixBot when you sign in. Off by default. The harness stays local.
        </div>
      </div>
      <button
        role="switch"
        aria-checked={on}
        onClick={() => {
          const next = !on;
          setOn(next);
          void login.set(next).then((enabled) => setOn(enabled === true));
        }}
        className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-raised")}
      >
        <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", on ? "left-[21px]" : "left-[3px]")} />
      </button>
    </div>
  );
}

/** Menu-bar / system-tray icon — desktop shell only; default on. */
function TrayRow() {
  const tray = window.ogb?.tray;
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!tray) return;
    void tray.get().then((enabled) => setOn(enabled !== false));
  }, [tray]);
  if (!tray) return null;
  return (
    <div className="mt-4 flex items-center justify-between gap-4 rounded-xl bg-card p-4">
      <div>
        <div className="text-[15px] font-medium text-ink">Tray icon</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          Keep VelarixBot in the tray when you close the window. Unread bots show a badge. On by default.
        </div>
      </div>
      <button
        role="switch"
        aria-checked={on}
        onClick={() => {
          const next = !on;
          setOn(next);
          void tray.set(next).then((enabled) => setOn(enabled !== false));
        }}
        className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-raised")}
      >
        <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", on ? "left-[21px]" : "left-[3px]")} />
      </button>
    </div>
  );
}
/** P1.7 one-click diagnostics + verified profile backup. The export is the
 * redacted support bundle (versions, capabilities, redacted logs, integrity
 * result) — no transcripts, no API keys. Backup writes a verified SQLite
 * snapshot into the local data directory. */
function DiagnosticsRow() {
  const [busy, setBusy] = useState<"export" | "backup" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const downloadExport = async () => {
    setBusy("export");
    setNote(null);
    try {
      const bundle = await api("/api/diagnostics/export");
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `velarixbot-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNote("Diagnostics saved. No transcripts or keys are included.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const backupNow = async () => {
    setBusy("backup");
    setNote(null);
    try {
      const { path } = await api("/api/diagnostics/backup", { method: "POST" });
      setNote(`Verified backup saved to ${path}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Diagnostics & backup</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Export versions, capabilities, redacted logs, and a database integrity result for support — transcripts and
        keys are never included. Backup writes a verified snapshot of your local data.
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void downloadExport()}
          disabled={busy !== null}
          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          {busy === "export" ? "Exporting…" : "Export diagnostics"}
        </button>
        <button
          onClick={() => void backupNow()}
          disabled={busy !== null}
          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          {busy === "backup" ? "Backing up…" : "Back up now"}
        </button>
      </div>
      {note && <div className="mt-2 break-all text-[12px] text-ink-secondary">{note}</div>}
    </div>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? `Downloading… ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ready — restart to apply`
            : s?.status === "error"
              ? `Check failed: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">App updates</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{label}</div>
      <div className="mt-3 flex gap-2">
        {s?.status === "available" ? (
          <button
            onClick={() => void updater.download()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            Download
          </button>
        ) : s?.status === "downloaded" ? (
          <button
            onClick={() => void updater.install()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            Restart to update
          </button>
        ) : (
          <button
            onClick={() => void updater.check()}
            disabled={s?.status === "checking" || s?.status === "downloading"}
            className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
          >
            Check for updates
          </button>
        )}
      </div>
    </div>
  );
}

export function AppSettingsPanel() {
  const { dispatch } = useStore();

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="w-6" />
        <span className="text-[15px] font-semibold text-ink">App Settings</span>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="mt-2 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Privacy</div>
          <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">No analytics, telemetry, account, name, or email collection. Bots, transcripts, routines, and credentials stay in the local VelarixBot data directory. Anyone using this computer account can access them.</div>
        </div>

        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Connections</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Shared by all bots. Saving a key reloads providers instantly; keys are stored locally and never
            shown again.
          </div>
          <div className="mt-4 flex flex-col gap-4">
            <ApiKeyRow section="composio" label="Composio Connect key" placeholder="ck_…" />
            <ApiKeyRow
              section="composioApi"
              label="Composio API key (optional)"
              placeholder="ak_…  unlocks the full app catalog"
            />
            <ApiKeyRow section="box" label="Box token" placeholder="Token from box.ascii.dev" />
            <ApiKeyRow
              section="github"
              label="GitHub token (private releases)"
              placeholder="ghp_…  write-only, used only to check VelarixBot releases"
            />
            <ApiKeyRow section="openrouter" label="OpenRouter key" placeholder="sk-or-…" />
            <ApiKeyRow section="omnirouter" label="OmniRouter key" placeholder="Paste key — never shown again" />
          </div>
        </div>

        <LaunchAtLoginRow />

        <TrayRow />

        <DiagnosticsRow />

        <UpdatesRow />
      </div>
    </aside>
  );
}
