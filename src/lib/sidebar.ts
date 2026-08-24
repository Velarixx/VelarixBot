/** Case-insensitive substring filter for the sidebar search box. Hidden
 * bots stay hidden; pin sort is preserved among matches. Empty query is
 * the full visible list. */
export function filterSidebarBots<T extends { name: string; title?: string; description?: string; hidden?: boolean; pinned?: boolean }>(
  bots: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  const visible = bots.filter((b) => !b.hidden);
  const matched = !q
    ? visible
    : visible.filter((b) =>
        [b.name, b.title ?? "", b.description ?? ""].some((s) => s.toLowerCase().includes(q)),
      );
  return [...matched].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
}

/** Bots have no project record. Settings `title` is the existing association
 * we group on — empty/whitespace titles are Unassigned. Not a project CRUD. */
export const UNASSIGNED_PROJECT_LABEL = "Unassigned";
export const UNASSIGNED_PROJECT_KEY = "";

export function projectKeyForBot(bot: { title?: string | null }): string {
  return typeof bot.title === "string" ? bot.title.trim() : "";
}

export function projectLabelForKey(key: string): string {
  return key || UNASSIGNED_PROJECT_LABEL;
}

export interface SidebarProjectGroup<T> {
  key: string;
  label: string;
  bots: T[];
  agentCount: number;
  runningCount: number;
}

function isRunning(bot: { state?: string; busy?: boolean }): boolean {
  return bot.state === "RUNNING" || bot.busy === true;
}

/** Group a (usually already filtered) agent list by the existing title
 * association. Same title renders together; no title → Unassigned last.
 * Pin order inside each group is the order the caller passed in. */
export function groupSidebarBotsByProject<T extends { title?: string | null; state?: string; busy?: boolean }>(
  bots: T[],
): SidebarProjectGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const bot of bots) {
    const key = projectKeyForBot(bot);
    const list = buckets.get(key);
    if (list) list.push(bot);
    else buckets.set(key, [bot]);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
  return keys.map((key) => {
    const groupBots = buckets.get(key)!;
    return {
      key,
      label: projectLabelForKey(key),
      bots: groupBots,
      agentCount: groupBots.length,
      runningCount: groupBots.filter(isRunning).length,
    };
  });
}

export function toggleProjectGroupCollapsed(collapsedKeys: readonly string[], key: string): string[] {
  return collapsedKeys.includes(key) ? collapsedKeys.filter((k) => k !== key) : [...collapsedKeys, key];
}

export function isProjectGroupExpanded(collapsedKeys: readonly string[], key: string): boolean {
  return !collapsedKeys.includes(key);
}

/** Collapse hides the group from the a11y tree; expand restores the same
 * agent identities. Collapsing one group never drops another group's bots. */
export function accessibleProjectGroupBots<T>(
  group: SidebarProjectGroup<T>,
  collapsedKeys: readonly string[],
): T[] {
  return isProjectGroupExpanded(collapsedKeys, group.key) ? group.bots : [];
}
