import { describe, expect, it } from "vitest";
import { filterSidebarBots } from "./sidebar";

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
