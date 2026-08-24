import { describe, expect, it } from "vitest";
import {
  UNASSIGNED_PROJECT_KEY,
  UNASSIGNED_PROJECT_LABEL,
  accessibleProjectGroupBots,
  filterSidebarBots,
  groupSidebarBotsByProject,
  isProjectGroupExpanded,
  projectKeyForBot,
  toggleProjectGroupCollapsed,
} from "./sidebar";

const bots = [
  { id: "a", name: "Alpha", title: "Writer", description: "Drafts docs", pinned: false },
  { id: "b", name: "Bravo", title: "Ops", description: "Watches deploys", pinned: true },
  { id: "c", name: "Charlie", title: "Research", description: "Reads papers", hidden: true },
];

describe("filterSidebarBots", () => {
  it("returns the full visible list for an empty query, pins first", () => {
    expect(filterSidebarBots(bots, "").map((b) => b.id)).toEqual(["b", "a"]);
    expect(filterSidebarBots(bots, "   ").map((b) => b.id)).toEqual(["b", "a"]);
  });

  it("matches name, title, or description case-insensitively", () => {
    expect(filterSidebarBots(bots, "alp").map((b) => b.id)).toEqual(["a"]);
    expect(filterSidebarBots(bots, "OPS").map((b) => b.id)).toEqual(["b"]);
    expect(filterSidebarBots(bots, "papers")).toEqual([]);
    expect(filterSidebarBots(bots, "drafts").map((b) => b.id)).toEqual(["a"]);
  });

  it("keeps hidden bots out of hits and pin-sorts among matches", () => {
    const extra = [
      ...bots,
      { id: "d", name: "Delta Writer", title: "", description: "", pinned: true },
      { id: "e", name: "Echo Writer", title: "", description: "", pinned: false, hidden: true },
    ];
    expect(filterSidebarBots(extra, "writer").map((b) => b.id)).toEqual(["d", "a"]);
  });
});

const writerA = { id: "a", name: "Alpha", title: "Writer", state: "IDLE" as const, pinned: false };
const writerB = { id: "b", name: "Bravo", title: "Writer", state: "RUNNING" as const, pinned: true };
const ops = { id: "c", name: "Charlie", title: "Ops", state: "IDLE" as const, busy: true };
const untitled = { id: "d", name: "Delta", title: "", state: "DONE" as const };
const whitespace = { id: "e", name: "Echo", title: "   ", state: "IDLE" as const };
const missing = { id: "f", name: "Foxtrot", state: "NEEDS_INPUT" as const };

describe("groupSidebarBotsByProject", () => {
  it("renders agents that share a title together under that project", () => {
    const groups = groupSidebarBotsByProject([writerA, ops, writerB]);
    expect(groups.map((g) => g.label)).toEqual(["Ops", "Writer"]);
    const writer = groups.find((g) => g.label === "Writer");
    expect(writer?.bots.map((b) => b.id)).toEqual(["a", "b"]);
    expect(writer?.agentCount).toBe(2);
    expect(writer?.runningCount).toBe(1);
  });

  it("keeps agents without a title accessible under Unassigned", () => {
    const groups = groupSidebarBotsByProject([writerA, untitled, whitespace, missing]);
    expect(groups.map((g) => g.key)).toEqual(["Writer", UNASSIGNED_PROJECT_KEY]);
    const unassigned = groups[1];
    expect(unassigned?.label).toBe(UNASSIGNED_PROJECT_LABEL);
    expect(unassigned?.bots.map((b) => b.id)).toEqual(["d", "e", "f"]);
    expect(projectKeyForBot({ title: null })).toBe(UNASSIGNED_PROJECT_KEY);
  });

  it("counts running from existing state/busy and preserves pin order inside a group", () => {
    const filtered = filterSidebarBots([writerA, writerB, untitled], "");
    const groups = groupSidebarBotsByProject(filtered);
    const writer = groups.find((g) => g.key === "Writer");
    expect(writer?.bots.map((b) => b.id)).toEqual(["b", "a"]);
    expect(writer?.runningCount).toBe(1);
    expect(groups.find((g) => g.key === UNASSIGNED_PROJECT_KEY)?.runningCount).toBe(0);
    expect(groupSidebarBotsByProject([ops])[0]?.runningCount).toBe(1);
  });
});

describe("project group expand/collapse accessibility", () => {
  it("hides agents while collapsed and restores the same identities on expand", () => {
    const [writer, unassigned] = groupSidebarBotsByProject([writerA, writerB, untitled]);
    expect(writer && unassigned).toBeTruthy();
    let collapsed: string[] = [];
    expect(isProjectGroupExpanded(collapsed, writer!.key)).toBe(true);
    expect(accessibleProjectGroupBots(writer!, collapsed).map((b) => b.id)).toEqual(["a", "b"]);

    collapsed = toggleProjectGroupCollapsed(collapsed, writer!.key);
    expect(isProjectGroupExpanded(collapsed, writer!.key)).toBe(false);
    expect(accessibleProjectGroupBots(writer!, collapsed)).toEqual([]);
    expect(accessibleProjectGroupBots(unassigned!, collapsed).map((b) => b.id)).toEqual(["d"]);

    collapsed = toggleProjectGroupCollapsed(collapsed, writer!.key);
    const restored = accessibleProjectGroupBots(writer!, collapsed);
    expect(restored).toEqual(writer!.bots);
    expect(restored[0]).toBe(writer!.bots[0]);
    expect(restored[1]).toBe(writer!.bots[1]);
  });
});

describe("status and controls inside a grouped section", () => {
  it("does not drop state or identity so sidebar status and actions still bind", () => {
    const groups = groupSidebarBotsByProject([
      { ...writerB, unread: true, pinned: true },
      { ...untitled, unread: false, pinned: false },
    ]);
    const writer = groups.find((g) => g.key === "Writer")?.bots[0];
    const open = accessibleProjectGroupBots(groups[0]!, []);
    expect(writer).toMatchObject({ id: "b", name: "Bravo", state: "RUNNING", unread: true, pinned: true });
    expect(open[0]).toBe(groups[0]!.bots[0]);
    expect(open[0]).toMatchObject({ id: "b", state: "RUNNING" });
  });
});
