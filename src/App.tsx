import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
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
      <div className="relative flex min-h-0 flex-1">
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

export default function App() {
  const [gated, setGated] = useState(() => !onboardingComplete());
  return (
    <StoreProvider>
      <Shell />
      {gated && <Onboarding onDone={() => setGated(false)} />}
    </StoreProvider>
  );
}
