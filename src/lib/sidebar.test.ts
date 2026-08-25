import { describe, expect, it } from "vitest";
import {
  UNASSIGNED_PROJECT_KEY,
  UNASSIGNED_PROJECT_LABEL,
  accessibleProjectGroupBots,
  filterSidebarBots,
  groupSidebarBotsByProject,
  isProjectGroupExpanded,
  moveToDestinations,
  normalizeSectionName,
  projectKeyForBot,
  toggleProjectGroupCollapsed,
  visibleSidebarSectionGroups,
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

const work = { id: "sec-work", name: "Work" };
const research = { id: "sec-research", name: "Research" };
const writerA = { id: "a", name: "Alpha", title: "Writer", sectionId: "sec-work", state: "IDLE" as const, pinned: false };
const writerB = { id: "b", name: "Bravo", title: "Editor", sectionId: "sec-work", state: "RUNNING" as const, pinned: true };
const ops = { id: "c", name: "Charlie", title: "Ops", sectionId: "sec-research", state: "IDLE" as const, busy: true };
const untitled = { id: "d", name: "Delta", title: "Writer", sectionId: null, state: "DONE" as const };
const whitespace = { id: "e", name: "Echo", title: "Ops", sectionId: "   ", state: "IDLE" as const };
const missing = { id: "f", name: "Foxtrot", title: "Research", state: "NEEDS_INPUT" as const };

describe("groupSidebarBotsByProject", () => {
  it("groups by sectionId and keeps different titles under one header", () => {
    const groups = groupSidebarBotsByProject([writerA, ops, writerB], [research, work]);
    expect(groups.map((g) => g.label)).toEqual(["Research", "Work"]);
    const workGroup = groups.find((g) => g.key === "sec-work");
    expect(workGroup?.bots.map((b) => b.id)).toEqual(["a", "b"]);
    expect(workGroup?.bots.map((b) => b.title)).toEqual(["Writer", "Editor"]);
    expect(workGroup?.agentCount).toBe(2);
    expect(workGroup?.runningCount).toBe(1);
  });

  it("keeps agents without a sectionId under Unassigned last", () => {
    const groups = groupSidebarBotsByProject([writerA, untitled, whitespace, missing], [work]);
    expect(groups.map((g) => g.key)).toEqual(["sec-work", UNASSIGNED_PROJECT_KEY]);
    const unassigned = groups[1];
    expect(unassigned?.label).toBe(UNASSIGNED_PROJECT_LABEL);
    expect(unassigned?.bots.map((b) => b.id)).toEqual(["d", "e", "f"]);
    expect(projectKeyForBot({ sectionId: null, title: "Writer" })).toBe(UNASSIGNED_PROJECT_KEY);
    expect(projectKeyForBot({ title: "Writer" })).toBe(UNASSIGNED_PROJECT_KEY);
  });

  it("lists empty user sections and omits Unassigned when it has no agents", () => {
    const groups = groupSidebarBotsByProject([writerA], [work, research]);
    expect(groups.map((g) => g.label)).toEqual(["Work", "Research"]);
    expect(groups.find((g) => g.key === "sec-research")?.agentCount).toBe(0);
    expect(groups.some((g) => g.key === UNASSIGNED_PROJECT_KEY)).toBe(false);
  });

  it("does not split bots by Title when they share a section or have none", () => {
    const groups = groupSidebarBotsByProject(
      [
        { id: "a", name: "A", title: "Writer", sectionId: "sec-work" },
        { id: "b", name: "B", title: "Ops", sectionId: "sec-work" },
        { id: "c", name: "C", title: "Writer" },
        { id: "d", name: "D", title: "Ops" },
      ],
      [work],
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.bots.map((b) => b.id)).toEqual(["a", "b"]);
    expect(groups[1]?.key).toBe(UNASSIGNED_PROJECT_KEY);
    expect(groups[1]?.bots.map((b) => b.id)).toEqual(["c", "d"]);
  });

  it("counts running from existing state/busy and preserves pin order inside a section", () => {
    const filtered = filterSidebarBots([writerA, writerB, untitled], "");
    const groups = groupSidebarBotsByProject(filtered, [work]);
    const workGroup = groups.find((g) => g.key === "sec-work");
    expect(workGroup?.bots.map((b) => b.id)).toEqual(["b", "a"]);
    expect(workGroup?.runningCount).toBe(1);
    expect(groups.find((g) => g.key === UNASSIGNED_PROJECT_KEY)?.runningCount).toBe(0);
    expect(groupSidebarBotsByProject([ops], [research])[0]?.runningCount).toBe(1);
  });

  it("keeps pin, search, and hidden filters inside a section", () => {
    const listed = [
      { ...writerA, pinned: false, hidden: false },
      { ...writerB, pinned: true, hidden: false },
      { id: "hidden-work", name: "Hidden Work", title: "Writer", sectionId: "sec-work", hidden: true, pinned: false },
    ];
    const filtered = filterSidebarBots(listed, "alp");
    const groups = groupSidebarBotsByProject(filtered, [work]);
    expect(groups[0]?.bots.map((b) => b.id)).toEqual(["a"]);
    expect(filtered.every((b) => !b.hidden)).toBe(true);
    expect(filterSidebarBots(listed, "").map((b) => b.id)).toEqual(["b", "a"]);
  });
});

describe("search hides empty section headers", () => {
  it("drops empty user sections only while a query is active", () => {
    const groups = groupSidebarBotsByProject([writerA], [work, research]);
    expect(visibleSidebarSectionGroups(groups, "").map((g) => g.label)).toEqual(["Work", "Research"]);
    expect(visibleSidebarSectionGroups(groups, "alp").map((g) => g.label)).toEqual(["Work"]);
  });
});

describe("section name rules", () => {
  it("rejects empty, Unassigned, and case-insensitive duplicates", () => {
    expect(normalizeSectionName("   ", []).ok).toBe(false);
    expect(normalizeSectionName("Unassigned", []).ok).toBe(false);
    expect(normalizeSectionName("Work", [work]).ok).toBe(false);
    expect(normalizeSectionName("work", [work]).ok).toBe(false);
    expect(normalizeSectionName("  Research  ", [work])).toEqual({ ok: true, name: "Research" });
    expect(normalizeSectionName("Work", [work], { exceptId: "sec-work" })).toEqual({ ok: true, name: "Work" });
  });
});

describe("Move to destinations", () => {
  it("lists user sections then Unassigned", () => {
    expect(moveToDestinations([work, research])).toEqual([
      { key: "sec-work", label: "Work" },
      { key: "sec-research", label: "Research" },
      { key: UNASSIGNED_PROJECT_KEY, label: UNASSIGNED_PROJECT_LABEL },
    ]);
  });
});

describe("project group expand/collapse accessibility", () => {
  it("hides agents while collapsed and restores the same identities on expand", () => {
    const [workGroup, unassigned] = groupSidebarBotsByProject([writerA, writerB, untitled], [work]);
    expect(workGroup && unassigned).toBeTruthy();
    let collapsed: string[] = [];
    expect(isProjectGroupExpanded(collapsed, workGroup!.key)).toBe(true);
    expect(accessibleProjectGroupBots(workGroup!, collapsed).map((b) => b.id)).toEqual(["a", "b"]);

    collapsed = toggleProjectGroupCollapsed(collapsed, workGroup!.key);
    expect(isProjectGroupExpanded(collapsed, workGroup!.key)).toBe(false);
    expect(accessibleProjectGroupBots(workGroup!, collapsed)).toEqual([]);
    expect(accessibleProjectGroupBots(unassigned!, collapsed).map((b) => b.id)).toEqual(["d"]);

    collapsed = toggleProjectGroupCollapsed(collapsed, workGroup!.key);
    const restored = accessibleProjectGroupBots(workGroup!, collapsed);
    expect(restored).toEqual(workGroup!.bots);
    expect(restored[0]).toBe(workGroup!.bots[0]);
    expect(restored[1]).toBe(workGroup!.bots[1]);
  });
});

describe("status and controls inside a grouped section", () => {
  it("does not drop state or identity so sidebar status and actions still bind", () => {
    const groups = groupSidebarBotsByProject(
      [
        { ...writerB, unread: true, pinned: true },
        { ...untitled, unread: false, pinned: false },
      ],
      [work],
    );
    const member = groups.find((g) => g.key === "sec-work")?.bots[0];
    const open = accessibleProjectGroupBots(groups[0]!, []);
    expect(member).toMatchObject({ id: "b", name: "Bravo", state: "RUNNING", unread: true, pinned: true });
    expect(open[0]).toBe(groups[0]!.bots[0]);
    expect(open[0]).toMatchObject({ id: "b", state: "RUNNING" });
  });
});
