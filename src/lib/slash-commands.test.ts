import { describe, expect, it } from "vitest";
import {
  filterSlashCommands,
  moveHighlight,
  slashMenuItems,
  slashQueryAt,
  SLASH_COMMANDS,
} from "./slash-commands";

describe("slashQueryAt", () => {
  it("opens on a leading slash", () => {
    expect(slashQueryAt("/", 1)).toEqual({ start: 0, query: "" });
    expect(slashQueryAt("/mod", 4)).toEqual({ start: 0, query: "mod" });
  });

  it("opens after whitespace", () => {
    expect(slashQueryAt("hello /st", 9)).toEqual({ start: 6, query: "st" });
  });

  it("ignores unix paths and mid-word slashes", () => {
    expect(slashQueryAt("/Users/foo", 10)).toBeNull();
    expect(slashQueryAt("a/b", 3)).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("lists every command for an empty query", () => {
    const hits = filterSlashCommands("", { busy: false });
    expect(hits.map((h) => h.command.name)).toEqual(SLASH_COMMANDS.map((c) => c.name));
  });

  it("filters by name and description", () => {
    expect(filterSlashCommands("model", { busy: false }).map((h) => h.command.name)).toEqual(["model"]);
    expect(filterSlashCommands("provider", { busy: false }).map((h) => h.command.name)).toEqual(["model"]);
    expect(filterSlashCommands("zzz", { busy: false })).toEqual([]);
  });

  it("closes once the token has a trailing space", () => {
    expect(filterSlashCommands("new ", { busy: false })).toEqual([]);
  });

  it("disables stop when idle and enables it while busy", () => {
    const idle = filterSlashCommands("stop", { busy: false });
    expect(idle).toEqual([{ command: SLASH_COMMANDS.find((c) => c.id === "stop"), enabled: false }]);
    const busy = filterSlashCommands("stop", { busy: true });
    expect(busy).toEqual([{ command: SLASH_COMMANDS.find((c) => c.id === "stop"), enabled: true }]);
  });
});

describe("slashMenuItems", () => {
  it("keeps the existing app commands and lists this bot's enabled skills", () => {
    const items = slashMenuItems("", { busy: false }, [
      { id: "s1", name: "File a report" },
      { id: "s2", name: "Inbox sweep" },
    ]);
    expect(items.filter((i) => i.kind === "command").map((i) => i.kind === "command" && i.hit.command.name)).toEqual(
      SLASH_COMMANDS.map((c) => c.name),
    );
    expect(items.filter((i) => i.kind === "skill").map((i) => i.kind === "skill" && i.hit.skill.name)).toEqual([
      "File a report",
      "Inbox sweep",
    ]);
  });

  it("does not invent new app commands", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(["new", "model", "computer", "attach", "stop", "help"]);
  });
});

describe("moveHighlight", () => {
  it("wraps keyboard movement", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });
});
