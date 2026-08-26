/** Per-chat Assigned tasks visibility. Keyed by bot.id and stored with the
 * existing local client prefs pattern (localStorage, velarixbot: prefix).
 * Hide/collapse never delete rows or stop a turn. */

export const TASK_PANEL_PREFS_KEY = "velarixbot:task-panel-prefs:v1";

export interface TaskPanelPref {
  collapsed: boolean;
  hidden: boolean;
}

export const DEFAULT_TASK_PANEL_PREF: TaskPanelPref = { collapsed: false, hidden: false };

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const memory = new Map<string, string>();
const memoryStorage: StorageLike = {
  getItem(key) {
    return memory.get(key) ?? null;
  },
  setItem(key, value) {
    memory.set(key, value);
  },
  removeItem(key) {
    memory.delete(key);
  },
};

function clientStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* private mode / SSR */
  }
  return memoryStorage;
}

function parsePrefs(raw: string | null): Record<string, TaskPanelPref> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, TaskPanelPref> = {};
    for (const [botId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!botId || !value || typeof value !== "object") continue;
      const row = value as Partial<TaskPanelPref>;
      out[botId] = {
        collapsed: row.collapsed === true,
        hidden: row.hidden === true,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function taskPanelPrefForBot(botId: string, storage: StorageLike = clientStorage()): TaskPanelPref {
  if (!botId) return { ...DEFAULT_TASK_PANEL_PREF };
  return parsePrefs(storage.getItem(TASK_PANEL_PREFS_KEY))[botId] ?? { ...DEFAULT_TASK_PANEL_PREF };
}

export function writeTaskPanelPref(
  botId: string,
  patch: Partial<TaskPanelPref>,
  storage: StorageLike = clientStorage(),
): TaskPanelPref {
  const all = parsePrefs(storage.getItem(TASK_PANEL_PREFS_KEY));
  const next = {
    ...taskPanelPrefForBot(botId, storage),
    ...patch,
  };
  all[botId] = next;
  try {
    storage.setItem(TASK_PANEL_PREFS_KEY, JSON.stringify(all));
  } catch {
    /* The panel stays usable when storage is unavailable. */
  }
  return next;
}

export function resetTaskPanelPrefsForTests(storage: StorageLike = clientStorage()): void {
  try {
    storage.removeItem(TASK_PANEL_PREFS_KEY);
  } catch {
    /* ignore */
  }
  memory.delete(TASK_PANEL_PREFS_KEY);
}
