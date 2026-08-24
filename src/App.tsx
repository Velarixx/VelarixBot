import { useState } from "react";
import { Loader2, Sparkles, WifiOff } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { onboardingComplete } from "@/lib/product";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { AppSettingsPanel } from "@/components/AppSettingsPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { RoutinesPanel } from "@/components/RoutinesPanel";
import { SkillsPanel } from "@/components/SkillsPanel";
import { CreateBotModal } from "@/components/CreateBotModal";
import { SessionBoundary } from "@/auth/SessionBoundary";
import {
  trustedClientApplicationMode,
  type ClientApplicationMode,
} from "@/auth/mode";
import { CatalogShell } from "@/saas/CatalogShell";
import { SaasErrorBoundary } from "@/saas/SaasErrorBoundary";
import { SaasRenderFailureProbe } from "@/saas/SaasRenderFailureProbe";

const ENABLE_SAAS_E2E_RENDER_FAILURE =
  import.meta.env.VITE_VELARIX_E2E_RENDER_FAILURE === "enabled";

function Shell() {
  const { state, dispatch } = useStore();
  const group = state.selectedGroupId
    ? state.groups.find((g) => g.id === state.selectedGroupId)
    : undefined;
  const bot = state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0];
  return (
    <div className="flex h-full flex-col">
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      {!state.connected && (state.bots.length > 0 || state.groups.length > 0) && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center gap-2 border-b border-warning/25 bg-warning/10 px-4 py-2 text-[12.5px] text-warning"
        >
          {state.hasConnected ? <WifiOff size={14} /> : <Loader2 size={14} className="animate-spin" />}
          <span>
            {state.hasConnected
              ? "Connection lost. Reconnecting — drafts stay here until you can send."
              : "Connecting to the bot server — drafts stay here until you can send."}
          </span>
        </div>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1">
      <Sidebar />
      {group ? (
        <GroupView group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : state.connected ? (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 bg-app">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-accent/10">
            <Sparkles size={32} className="text-accent" />
          </div>
          <div className="flex flex-col items-center gap-1.5 text-center">
            <h2 className="text-[18px] font-semibold text-ink">No bots yet</h2>
            <p className="max-w-[360px] text-[14px] text-ink-secondary">
              Create your first bot to start chatting. Each bot has its own conversation and settings.
            </p>
          </div>
          <button
            onClick={() => dispatch({ type: "toggleCreateBot", open: true })}
            className="mt-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-white hover:bg-accent/90"
          >
            Create a bot
          </button>
        </main>
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">Connecting to the bot server…</div>
          <div className="text-[12px]">
            Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
          </div>
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && <ComputerPanel bot={bot} />}
      {state.appSettingsOpen && <AppSettingsPanel />}
      {state.pluginsOpen && <PluginsPanel />}
      {state.routinesOpen && <RoutinesPanel />}
      {state.skillsOpen && <SkillsPanel />}
      {state.createBotOpen && <CreateBotModal />}
      </div>
    </div>
  );
}

export function DesktopApplication() {
  const [gated, setGated] = useState(() => !onboardingComplete());
  return (
    <StoreProvider>
      <Shell />
      {gated && <Onboarding onDone={() => setGated(false)} />}
    </StoreProvider>
  );
}

export function InvalidApplicationMode() {
  return (
    <main className="flex min-h-full items-center justify-center bg-app px-5 py-10 text-ink">
      <section role="alert" className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-lg">
        <h1 tabIndex={-1} className="text-[20px] font-semibold outline-none">This app can’t start safely</h1>
        <p className="mt-2 text-[14px] leading-6 text-ink-secondary">
          The application mode is invalid. Product access remains closed.
        </p>
      </section>
    </main>
  );
}

export function SaasApplication() {
  const application = (
    <SessionBoundary
      renderAuthenticated={({ onSessionLost, onRequestSignOut, signOutTriggerRef }) => (
        <CatalogShell
          onSessionLost={onSessionLost}
          onRequestSignOut={onRequestSignOut}
          signOutTriggerRef={signOutTriggerRef}
        />
      )}
    />
  );
  return (
    <SaasErrorBoundary>
      {ENABLE_SAAS_E2E_RENDER_FAILURE
        ? <SaasRenderFailureProbe>{application}</SaasRenderFailureProbe>
        : application}
    </SaasErrorBoundary>
  );
}

export function ApplicationRoot({ mode }: { mode: ClientApplicationMode }) {
  if (mode === "desktop") return <DesktopApplication />;
  if (mode === "saas") return <SaasApplication />;
  return <InvalidApplicationMode />;
}

export default function App() {
  return <ApplicationRoot mode={trustedClientApplicationMode()} />;
}
