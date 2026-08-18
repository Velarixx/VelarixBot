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
