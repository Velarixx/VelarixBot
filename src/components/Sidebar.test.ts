import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const sidebar = readFileSync(join(HERE, "Sidebar.tsx"), "utf8");

describe("conversation-first sidebar hierarchy", () => {
  it("orders the approved visible groups and keeps App Settings at the bottom", () => {
    const conversations = sidebar.indexOf("Conversations");
    const automate = sidebar.indexOf("Automate");
    const routines = sidebar.indexOf(">Routines<");
    const skills = sidebar.indexOf(">Skills<");
    const connect = sidebar.indexOf("Connect");
    const apps = sidebar.indexOf(">Apps<");
    const appSettings = sidebar.indexOf(">App Settings<");

    expect([conversations, automate, routines, skills, connect, apps, appSettings].every((index) => index >= 0)).toBe(true);
    expect(conversations).toBeLessThan(automate);
    expect(automate).toBeLessThan(routines);
    expect(routines).toBeLessThan(skills);
    expect(skills).toBeLessThan(connect);
    expect(connect).toBeLessThan(apps);
    expect(apps).toBeLessThan(appSettings);
  });

  it("exposes named landmarks and the current state of utility destinations", () => {
    expect(sidebar).toContain('aria-label="Workspace sidebar"');
    expect(sidebar).toContain('aria-label="Search conversations"');
    expect(sidebar).toContain('aria-label="Workspace navigation"');
    expect(sidebar).toContain('aria-labelledby="sidebar-conversations-heading"');
    expect(sidebar).toContain('aria-labelledby="sidebar-automate-heading"');
    expect(sidebar).toContain('aria-labelledby="sidebar-connect-heading"');
    expect(sidebar).toContain("aria-pressed={state.routinesOpen}");
    expect(sidebar).toContain("aria-pressed={state.skillsOpen}");
    expect(sidebar).toContain("aria-pressed={state.pluginsOpen}");
    expect(sidebar).toContain("aria-pressed={state.appSettingsOpen}");
  });

  it("preserves every existing destination and open-close dispatch", () => {
    expect(sidebar).toContain('dispatch({ type: "toggleCreateBot", open: true })');
    expect(sidebar).toContain('dispatch({ type: "select", id: bot.id })');
    expect(sidebar).toContain('dispatch({ type: "selectGroup", id: group.id })');
    expect(sidebar).toContain('dispatch({ type: "toggleRoutines" })');
    expect(sidebar).toContain('dispatch({ type: "toggleSkills" })');
    expect(sidebar).toContain('dispatch({ type: "togglePlugins", open: true })');
    expect(sidebar).toContain('dispatch({ type: "toggleAppSettings" })');
  });

  it("keeps search, pin, and unread conversation behavior wired", () => {
    expect(sidebar).toContain("filterSidebarBots(state.bots, query)");
    expect(sidebar).toContain("bot.pinned ? \"Unpin\" : \"Pin\"");
    expect(sidebar).toContain('dispatch({ type: "markUnread", botId: bot.id })');
    expect(sidebar).toContain("bot.unread &&");
    expect(sidebar).toContain("group.unread &&");
  });
});

describe("project grouping in the agent list", () => {
  it("groups the filtered list by first-class sectionId, not Title", () => {
    expect(sidebar).toContain("groupSidebarBotsByProject(visibleBots, sections)");
    expect(sidebar).toContain("visibleSidebarSectionGroups(");
    expect(sidebar).toContain("group.label");
    expect(sidebar).toContain("group.agentCount");
    expect(sidebar).toContain("group.runningCount");
    expect(sidebar).toContain('group.key || "unassigned"');
    expect(sidebar).toContain("Move to");
    expect(sidebar).toContain("New section…");
    expect(sidebar).toContain("onMove");
    expect(sidebar).not.toContain("patch: { title");
  });

  it("keeps collapse state on the header and agents mounted for accessibility", () => {
    expect(sidebar).toContain("aria-expanded={expanded}");
    expect(sidebar).toContain("aria-controls={panelId}");
    expect(sidebar).toContain("hidden={!expanded}");
    expect(sidebar).toContain('!expanded && "hidden"');
    expect(sidebar).toContain("toggleProjectGroupCollapsed(collapsedProjects, group.key)");
    expect(sidebar).toContain("isProjectGroupExpanded(collapsedProjects, group.key)");
    expect(sidebar).toContain("<BotListItem key={b.id} bot={b} onMenu={setMenu} />");
    expect(sidebar).toContain('"/api/sidebar-sections/collapsed"');
  });

  it("keeps per-agent status and controls inside each grouped section", () => {
    const header = sidebar.indexOf("projectGroups.map");
    const item = sidebar.indexOf("function BotListItem");
    const status = sidebar.indexOf("stateLabel(bot.state ?? \"IDLE\")");
    const select = sidebar.indexOf('dispatch({ type: "select", id: bot.id })');
    const menu = sidebar.indexOf("onContextMenu");
    expect([header, item, status, select, menu].every((index) => index >= 0)).toBe(true);
    expect(item).toBeLessThan(header);
    expect(sidebar).toContain("stateTone[bot.state ?? \"IDLE\"]");
    expect(sidebar).toContain('dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } })');
    expect(sidebar).toContain('dispatch({ type: "deleteBot", botId: bot.id })');
    expect(sidebar).toContain('dispatch({ type: "updateBot", botId, patch: { sectionId } })');
  });

  it("keeps A⇄B DMs under Direct messages and out of sections", () => {
    const sections = sidebar.indexOf("projectGroups.map");
    const dms = sidebar.indexOf("Direct messages");
    expect(sections).toBeGreaterThan(-1);
    expect(dms).toBeGreaterThan(sections);
    expect(sidebar).toContain("g.dm &&");
  });
});
