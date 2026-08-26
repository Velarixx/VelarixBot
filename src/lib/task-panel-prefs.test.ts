import { afterEach, describe, expect, it } from "vitest";

import {
  resetTaskPanelPrefsForTests,
  taskPanelPrefForBot,
  writeTaskPanelPref,
} from "./task-panel-prefs";

const memory = new Map<string, string>();
const storage = {
  getItem(key: string) {
    return memory.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    memory.set(key, value);
  },
  removeItem(key: string) {
    memory.delete(key);
  },
};

describe("task panel prefs", () => {
  afterEach(() => {
    memory.clear();
    resetTaskPanelPrefsForTests(storage);
  });

  it("persists collapse and hide for bot A without affecting bot B", () => {
    expect(taskPanelPrefForBot("bot-a", storage)).toEqual({ collapsed: false, hidden: false });
    expect(taskPanelPrefForBot("bot-b", storage)).toEqual({ collapsed: false, hidden: false });

    writeTaskPanelPref("bot-a", { collapsed: true }, storage);
    expect(taskPanelPrefForBot("bot-a", storage)).toEqual({ collapsed: true, hidden: false });
    expect(taskPanelPrefForBot("bot-b", storage)).toEqual({ collapsed: false, hidden: false });

    writeTaskPanelPref("bot-a", { hidden: true }, storage);
    const reloadedA = taskPanelPrefForBot("bot-a", storage);
    const reloadedB = taskPanelPrefForBot("bot-b", storage);
    expect(reloadedA).toEqual({ collapsed: true, hidden: true });
    expect(reloadedB).toEqual({ collapsed: false, hidden: false });
  });
});
