import { useEffect, useState } from "react";
import {
  BellDot,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  EyeOff,
  FolderInput,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Puzzle,
  Trash2,
  CalendarClock,
  BookOpen,
} from "lucide-react";
import { api, useStore, formatTime, type Bot, type Group } from "@/state/store";
import { BotFace } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { formatCompactTokens, formatUsageCost, stateLabel, type BotState } from "@/lib/product";
import {
  filterSidebarBots,
  groupSidebarBotsByProject,
  isProjectGroupExpanded,
  moveToDestinations,
  normalizeSectionName,
  projectKeyForBot,
  toggleProjectGroupCollapsed,
  visibleSidebarSectionGroups,
  type SidebarSection,
} from "@/lib/sidebar";

const isElectron = navigator.userAgent.includes("Electron");

const stateTone: Record<BotState, string> = { IDLE: "bg-raised text-ink-secondary", RUNNING: "bg-accent/15 text-accent", DONE: "bg-success/15 text-success", BLOCKED: "bg-danger/15 text-danger", NEEDS_INPUT: "bg-warning/15 text-warning" };

function preview(bot: Bot): string {
  if (bot.busy) return "Working…";
  const last = bot.messages[bot.messages.length - 1];
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return "Screen frame";
  return last.text ?? "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

interface SectionMenuState {
  sectionId: string;
  x: number;
  y: number;
}

function promptSectionName(existing: SidebarSection[], opts?: { initial?: string; exceptId?: string }): string | null {
  const raw = window.prompt(opts?.initial ? "Rename section" : "Section name", opts?.initial ?? "");
  if (raw == null) return null;
  const parsed = normalizeSectionName(raw, existing, opts?.exceptId ? { exceptId: opts.exceptId } : undefined);
  if (!parsed.ok) {
    window.alert(parsed.error);
    return null;
  }
  return parsed.name;
}

function BotContextMenu({
  menu,
  sections,
  onClose,
  onMove,
  onNewSection,
}: {
  menu: MenuState;
  sections: SidebarSection[];
  onClose: () => void;
  onMove: (botId: string, sectionId: string | null) => void;
  onNewSection: (botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  // keep the menu on-screen near the click
  const destinations = moveToDestinations(sections);
  const currentKey = projectKeyForBot(bot);
  const top = Math.min(menu.y, window.innerHeight - 420);
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? "Unpin" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(<BellDot size={16} className="text-ink-secondary" />, "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        <div key="move-label" className="flex items-center gap-3 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
          <FolderInput size={14} />
          Move to
        </div>,
        ...destinations.map((dest) =>
          item(
            <span className="w-4" />,
            dest.label,
            dest.key === currentKey ? undefined : () => onMove(bot.id, dest.key || null),
            dest.key === currentKey ? { disabled: true, hint: "Already in this section" } : undefined,
          ),
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, "New section…", () => onNewSection(bot.id)),
        divider("d2b"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(<EyeOff size={16} className="text-ink-secondary" />, "Hide from sidebar", () =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { hidden: true } }),
        ),
        item(<Trash2 size={16} />, "Delete", () => dispatch({ type: "deleteBot", botId: bot.id }), {
          danger: true,
          disabled: state.bots.length <= 1,
          hint: state.bots.length <= 1 ? "Keep at least one bot in the workspace" : undefined,
        }),
      ]}
    </div>
  );
}

function DmListItem({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const selected = state.selectedGroupId === group.id;
  const last = group.messages[group.messages.length - 1];
  const previewText =
    last?.kind === "activity" && last.tool
      ? last.tool.name
      : last?.text ?? "";
  return (
    <button
      onClick={() => dispatch({ type: "selectGroup", id: group.id })}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[13px] font-semibold text-accent">
        ⇄
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-ink">{group.name}</span>
          {last && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(last.at)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">{previewText}</span>
          {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>
      </div>
    </button>
  );
}

function BotListItem({ bot, onMenu }: { bot: Bot; onMenu: (menu: MenuState) => void }) {
  const { state, dispatch } = useStore();
  const selected = state.selectedGroupId == null && state.selectedId === bot.id;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const last = bot.messages[bot.messages.length - 1];
  return (
    <button
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <BotFace
        bot={bot}
        state={stateForBot(bot)}
        size={56}
        motion={mascotMotion?.kind ?? "none"}
        motionKey={mascotMotion?.nonce ?? 0}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <span className="truncate">{bot.name}</span>
          </span>
          {selected && last && (
            <span className="shrink-0 text-xs text-ink-secondary">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">
            {preview(bot)}
          </span>
          <span title={bot.stateDetail} className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide", stateTone[bot.state ?? "IDLE"])}>{stateLabel(bot.state ?? "IDLE")}</span>
          {bot.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>
        <div className="mt-0.5 text-[10.5px] text-ink-secondary">{formatCompactTokens((bot.usage?.input ?? 0) + (bot.usage?.output ?? 0))} tokens · {formatUsageCost(bot.usage?.cost ?? null)}</div>
      </div>
    </button>
  );
}

function SectionContextMenu({
  menu,
  sections,
  onClose,
  onRename,
  onDelete,
}: {
  menu: SectionMenuState;
  sections: SidebarSection[];
  onClose: () => void;
  onRename: (sectionId: string) => void;
  onDelete: (sectionId: string) => void;
}) {
  const section = sections.find((row) => row.id === menu.sectionId);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-section-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  if (!section) return null;
  const top = Math.min(menu.y, window.innerHeight - 140);
  const left = Math.min(menu.x, window.innerWidth - 200);
  return (
    <div
      data-section-menu
      style={{ top, left }}
      className="fixed z-40 w-[200px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      <button
        onClick={() => {
          onRename(section.id);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <Pencil size={16} className="text-ink-secondary" />
        Rename
      </button>
      <button
        onClick={() => {
          onDelete(section.id);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        Delete
      </button>
    </div>
  );
}

export function Sidebar() {
  const { state, dispatch } = useStore();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionMenu, setSectionMenu] = useState<SectionMenuState | null>(null);
  const [query, setQuery] = useState("");
  const [sections, setSections] = useState<SidebarSection[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);

  useEffect(() => {
    api("/api/sidebar-sections")
      .then((body: { sections?: SidebarSection[]; collapsed?: string[] }) => {
        setSections(Array.isArray(body.sections) ? body.sections : []);
        setCollapsedProjects(Array.isArray(body.collapsed) ? body.collapsed : []);
      })
      .catch(() => {});
  }, []);

  const persistCollapsed = (keys: string[]) => {
    setCollapsedProjects(keys);
    api("/api/sidebar-sections/collapsed", { method: "PUT", body: JSON.stringify({ collapsed: keys }) }).catch(() => {});
  };

  const applySections = (body: { sections?: SidebarSection[]; collapsed?: string[] }) => {
    if (Array.isArray(body.sections)) setSections(body.sections);
    if (Array.isArray(body.collapsed)) setCollapsedProjects(body.collapsed);
  };

  const createSection = async (name: string): Promise<SidebarSection | null> => {
    try {
      const body = await api("/api/sidebar-sections", { method: "POST", body: JSON.stringify({ name }) });
      applySections(body);
      return body.section ?? null;
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not create section");
      return null;
    }
  };

  const renameSection = async (sectionId: string) => {
    const current = sections.find((row) => row.id === sectionId);
    if (!current) return;
    const name = promptSectionName(sections, { initial: current.name, exceptId: sectionId });
    if (!name || name === current.name) return;
    try {
      applySections(await api(`/api/sidebar-sections/${sectionId}`, { method: "PATCH", body: JSON.stringify({ name }) }));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not rename section");
    }
  };

  const deleteSection = async (sectionId: string) => {
    const current = sections.find((row) => row.id === sectionId);
    if (!current) return;
    if (!window.confirm(`Delete section “${current.name}”? Agents in it become Unassigned. Bots are not deleted.`)) return;
    try {
      const members = state.bots.filter((bot) => projectKeyForBot(bot) === sectionId);
      applySections(await api(`/api/sidebar-sections/${sectionId}`, { method: "DELETE" }));
      for (const bot of members) {
        dispatch({ type: "botPatched", bot: { id: bot.id, sectionId: null } });
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not delete section");
    }
  };

  const moveBot = (botId: string, sectionId: string | null) => {
    const bot = state.bots.find((row) => row.id === botId);
    if (!bot) return;
    if (projectKeyForBot(bot) === (sectionId ?? "")) return;
    dispatch({ type: "updateBot", botId, patch: { sectionId } });
  };

  const moveBotToNewSection = async (botId: string) => {
    const name = promptSectionName(sections);
    if (!name) return;
    const section = await createSection(name);
    if (section) moveBot(botId, section.id);
  };

  const visibleBots = filterSidebarBots(state.bots, query);
  const projectGroups = visibleSidebarSectionGroups(groupSidebarBotsByProject(visibleBots, sections), query);

  return (
    <aside
      aria-label="Workspace sidebar"
      className="flex h-full w-[320px] shrink-0 flex-col border-r border-hairline/40 bg-panel"
    >
      {/* Titlebar: real traffic lights in Electron, faux ones in the browser */}
      <div
        className="flex items-center justify-between px-4 pt-3.5 pb-1"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {isElectron ? (
          <div className="w-14" />
        ) : (
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        )}
        <button
          onClick={() => dispatch({ type: "toggleCreateBot", open: true })}
          aria-label="New bot"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title="New bot"
        >
          <Plus size={20} strokeWidth={2} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pt-2 pb-3">
        <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
          <Search size={16} className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search conversations"
            placeholder="Search"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>

      {/* Bot list + A ⇄ B DMs */}
      <section aria-labelledby="sidebar-conversations-heading" className="flex-1 overflow-y-auto px-2">
        <div className="flex items-center justify-between gap-2 px-3 pb-1">
          <h2
            id="sidebar-conversations-heading"
            className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary"
          >
            Conversations
          </h2>
          <button
            type="button"
            aria-label="New section"
            title="New section"
            onClick={async () => {
              const name = promptSectionName(sections);
              if (name) await createSection(name);
            }}
            className="rounded-md p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <FolderPlus size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-1">
          {projectGroups.map((group) => {
            const expanded = isProjectGroupExpanded(collapsedProjects, group.key);
            const panelId = `sidebar-project-${group.key || "unassigned"}`;
            return (
              <div key={group.key || "unassigned"} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => persistCollapsed(toggleProjectGroupCollapsed(collapsedProjects, group.key))}
                  onContextMenu={(e) => {
                    if (!group.key) return;
                    e.preventDefault();
                    setSectionMenu({ sectionId: group.key, x: e.clientX, y: e.clientY });
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-raised/50"
                >
                  {expanded ? (
                    <ChevronDown size={14} className="shrink-0 text-ink-secondary" />
                  ) : (
                    <ChevronRight size={14} className="shrink-0 text-ink-secondary" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">{group.label}</span>
                  <span className="shrink-0 text-[11px] text-ink-secondary">{group.agentCount}</span>
                  {group.runningCount > 0 && (
                    <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                      {group.runningCount} running
                    </span>
                  )}
                </button>
                <div
                  id={panelId}
                  role="group"
                  aria-label={group.label}
                  hidden={!expanded}
                  className={cn("flex flex-col gap-0.5", !expanded && "hidden")}
                >
                  {group.bots.map((b) => (
                    <BotListItem key={b.id} bot={b} onMenu={setMenu} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {(() => {
          const q = query.trim().toLowerCase();
          const dms = state.groups.filter((g) => g.dm && (!q || g.name.toLowerCase().includes(q)));
          if (!dms.length) return null;
          return (
            <div className="mt-3">
              <h3 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
                Direct messages
              </h3>
              <div className="flex flex-col gap-0.5">
                {dms.map((g) => (
                  <DmListItem key={g.id} group={g} />
                ))}
              </div>
            </div>
          );
        })()}
      </section>

      {/* Grouped utility navigation */}
      <nav aria-label="Workspace navigation" className="px-3 pb-3 pt-2">
        <section aria-labelledby="sidebar-automate-heading">
          <h2
            id="sidebar-automate-heading"
            className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary"
          >
            Automate
          </h2>
          <button
            onClick={() => dispatch({ type: "toggleRoutines" })}
            aria-pressed={state.routinesOpen}
            className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50", state.routinesOpen && "bg-raised")}
          >
            <CalendarClock size={20} className="text-ink-secondary" />
            <span className="flex-1 text-[14px] text-ink">Routines</span>
            {state.routines.filter((routine) => routine.enabled).length > 0 && <span className="text-[11px] text-ink-secondary">{state.routines.filter((routine) => routine.enabled).length}</span>}
          </button>
          <button
            onClick={() => dispatch({ type: "toggleSkills" })}
            aria-pressed={state.skillsOpen}
            className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50", state.skillsOpen && "bg-raised")}
          >
            <BookOpen size={20} className="text-ink-secondary" />
            <span className="text-[14px] text-ink">Skills</span>
          </button>
        </section>

        <section aria-labelledby="sidebar-connect-heading" className="mt-2">
          <h2
            id="sidebar-connect-heading"
            className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary"
          >
            Connect
          </h2>
          <button
            onClick={() => dispatch({ type: "togglePlugins", open: true })}
            aria-pressed={state.pluginsOpen}
            className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50", state.pluginsOpen && "bg-raised")}
          >
            <Puzzle size={20} className="text-ink-secondary" />
            <span className="text-[14px] text-ink">Apps</span>
          </button>
        </section>

        <div className="mt-2 border-t border-hairline/40 pt-2">
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            aria-pressed={state.appSettingsOpen}
            className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50", state.appSettingsOpen && "bg-raised")}
          >
            <Settings size={20} className="text-ink-secondary" />
            <span className="text-[14px] text-ink">App Settings</span>
          </button>
        </div>
      </nav>

      {menu && (
        <BotContextMenu
          menu={menu}
          sections={sections}
          onClose={() => setMenu(null)}
          onMove={moveBot}
          onNewSection={(botId) => {
            void moveBotToNewSection(botId);
          }}
        />
      )}
      {sectionMenu && (
        <SectionContextMenu
          menu={sectionMenu}
          sections={sections}
          onClose={() => setSectionMenu(null)}
          onRename={(sectionId) => {
            void renameSection(sectionId);
          }}
          onDelete={(sectionId) => {
            void deleteSection(sectionId);
          }}
        />
      )}
    </aside>
  );
}
