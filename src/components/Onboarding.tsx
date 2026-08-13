import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Mic, ShieldCheck } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { markOnboardingComplete } from "@/lib/product";

type InstanceRow = {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: { state: "available" | "unavailable"; reason?: string; version?: string | null; authenticated?: boolean };
};

const isElectron = navigator.userAgent.includes("Electron");

function StatusRow({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-card p-3.5">
      <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${ok ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>
        {ok ? <Check size={14} /> : <AlertTriangle size={13} />}
      </span>
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{detail}</div>
      </div>
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [instances, setInstances] = useState<InstanceRow[] | null>(null);
  const [perms, setPerms] = useState<{ mic: string } | null>(null);

  useEffect(() => {
    if (step === 1 && !instances) {
      fetch("/api/instances").then((r) => r.json()).then((d) => setInstances(d.instances ?? [])).catch(() => setInstances([]));
    }
    if (step === 2 && isElectron) {
      const poll = () => window.ogb?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      const timer = setInterval(poll, 2000);
      return () => clearInterval(timer);
    }
  }, [step, instances]);

  const finish = () => { markOnboardingComplete(); onDone(); };
  const byKind = (kind: string) => instances?.find((instance) => instance.driverKind === kind);
  const engines = [
    ["claudeAgent", "Claude Code", "npm i -g @anthropic-ai/claude-code"],
    ["codex", "Codex", "npm i -g @openai/codex"],
    ["grokAgent", "Grok", "curl -fsSL https://x.ai/cli/install.sh | bash"],
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app p-4">
      <div className="flex w-full max-w-[460px] flex-col rounded-2xl border border-hairline/40 bg-panel p-8">
        {step === 0 && <div className="flex flex-col items-center text-center">
          <MausAvatar color="green" state="happy" size={72} />
          <h1 className="mt-4 text-[20px] font-semibold text-ink">Welcome to VelarixBot</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-secondary">Set up the local agent tools already on this computer. No account, name, email, analytics, or telemetry is required.</p>
          <div className="mt-5 flex w-full items-start gap-3 rounded-xl bg-card p-4 text-left">
            <ShieldCheck size={20} className="shrink-0 text-success" />
            <div><div className="text-[14px] font-medium text-ink">Local first</div><div className="mt-0.5 text-[12.5px] text-ink-secondary">This first-run completion flag stays only in this browser profile.</div></div>
          </div>
          <button autoFocus onClick={() => setStep(1)} className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">Check local engines</button>
        </div>}

        {step === 1 && <div className="flex flex-col">
          <h1 className="text-[18px] font-semibold text-ink">Local engines</h1>
          <p className="mt-1 text-[13.5px] text-ink-secondary">VelarixBot uses each CLI directly with its existing login or OAuth session. Choose a model explicitly for every bot; it never silently fails over.</p>
          <div className="mt-4 flex flex-col gap-2.5">
            {!instances ? <div className="flex items-center gap-2 py-6 text-ink-secondary"><Loader2 size={16} className="animate-spin" /> Checking…</div> : engines.map(([kind, label, install]) => {
              const engine = byKind(kind); const ok = engine?.snapshot.state === "available";
              return <StatusRow key={kind} ok={ok} title={`${label}${engine?.snapshot.version ? ` · ${engine.snapshot.version}` : ""}`} detail={ok ? (engine?.snapshot.authenticated === false ? `Installed; finish login in the ${label} CLI.` : "Installed and available.") : `Not found. Install with: ${install}`} />;
            })}
          </div>
          <button onClick={() => isElectron ? setStep(2) : finish()} className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">{isElectron ? "Continue" : "Start using VelarixBot"}</button>
          <button onClick={finish} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">Skip for now</button>
        </div>}

        {step === 2 && <div className="flex flex-col">
          <h1 className="text-[18px] font-semibold text-ink">Optional microphone</h1>
          <p className="mt-1 text-[13.5px] text-ink-secondary">Only requested for dictation when you choose to enable it. Speech is transcribed on device.</p>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-card p-3.5">
            <div className="flex items-start gap-3"><Mic size={18} className="mt-0.5 text-ink-secondary" /><div><div className="text-[14px] font-medium text-ink">Microphone & speech</div><div className="text-[12.5px] text-ink-secondary">Composer voice input</div></div></div>
            {perms?.mic === "granted" ? <Check size={16} className="text-success" /> : perms?.mic === "denied" || perms?.mic === "restricted" ? <button onClick={() => window.ogb?.permOpenSettings?.("mic")} className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink">Open Settings</button> : <button onClick={() => window.ogb?.permRequestMic?.().then(() => window.ogb?.permStatus?.().then(setPerms))} className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink">Enable</button>}
          </div>
          <button onClick={finish} className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">Start using VelarixBot</button>
          <button onClick={finish} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">Skip for now</button>
        </div>}
      </div>
    </div>
  );
}
