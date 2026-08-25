/** Case-insensitive substring filter for the sidebar search box. Hidden
 * bots stay hidden; pin sort is preserved among matches. Empty query is
 * the full visible list. Title remains a personality search field. */
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

/** First-class user-created Conversations section. Not derived from Title. */
export interface SidebarSection {
  id: string;
  name: string;
}

/** Bots with no sectionId land here. Not a user-created row. */
export const UNASSIGNED_PROJECT_LABEL = "Unassigned";
export const UNASSIGNED_PROJECT_KEY = "";
export const UNASSIGNED_SECTION_LABEL = UNASSIGNED_PROJECT_LABEL;
export const UNASSIGNED_SECTION_KEY = UNASSIGNED_PROJECT_KEY;

export function sectionKeyForBot(bot: { sectionId?: string | null }): string {
  return typeof bot.sectionId === "string" ? bot.sectionId.trim() : "";
}

/** @deprecated Title is a personality field. Grouping uses sectionId. */
export function projectKeyForBot(bot: { sectionId?: string | null; title?: string | null }): string {
  return sectionKeyForBot(bot);
}

export function projectLabelForKey(key: string, sections: readonly SidebarSection[] = []): string {
  if (!key) return UNASSIGNED_PROJECT_LABEL;
  return sections.find((section) => section.id === key)?.name ?? UNASSIGNED_PROJECT_LABEL;
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

export function normalizeSectionName(
  raw: unknown,
  existing: readonly SidebarSection[],
  opts?: { exceptId?: string },
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "name must be a string" };
  const name = raw.trim();
  if (!name) return { ok: false, error: "name cannot be empty" };
  if (name.toLowerCase() === UNASSIGNED_PROJECT_LABEL.toLowerCase()) {
    return { ok: false, error: "Unassigned is not a user section" };
  }
  const taken = existing.some(
    (section) =>
      section.id !== opts?.exceptId && section.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (taken) return { ok: false, error: "section name already exists" };
  return { ok: true, name };
}

/** Destinations on the agent context-menu Move to list. Unassigned is
 * always offered; New section… is a separate action in the UI. */
export function moveToDestinations(sections: readonly SidebarSection[]): Array<{ key: string; label: string }> {
  return [
    ...sections.map((section) => ({ key: section.id, label: section.name })),
    { key: UNASSIGNED_PROJECT_KEY, label: UNASSIGNED_PROJECT_LABEL },
  ];
}

/** Group a (usually already filtered) agent list by first-class sectionId.
 * User sections stay visible even when empty. Unknown/empty sectionId →
 * Unassigned, last, and only when it has agents. Title is ignored. */
export function groupSidebarBotsByProject<
  T extends { sectionId?: string | null; title?: string | null; state?: string; busy?: boolean },
>(bots: T[], sections: readonly SidebarSection[] = []): SidebarProjectGroup<T>[] {
  const known = new Set(sections.map((section) => section.id));
  const buckets = new Map<string, T[]>();
  for (const section of sections) buckets.set(section.id, []);
  const unassigned: T[] = [];
  for (const bot of bots) {
    const key = sectionKeyForBot(bot);
    if (key && known.has(key)) buckets.get(key)!.push(bot);
    else unassigned.push(bot);
  }
  const groups: SidebarProjectGroup<T>[] = sections.map((section) => {
    const groupBots = buckets.get(section.id) ?? [];
    return {
      key: section.id,
      label: section.name,
      bots: groupBots,
      agentCount: groupBots.length,
      runningCount: groupBots.filter(isRunning).length,
    };
  });
  if (unassigned.length) {
    groups.push({
      key: UNASSIGNED_PROJECT_KEY,
      label: UNASSIGNED_PROJECT_LABEL,
      bots: unassigned,
      agentCount: unassigned.length,
      runningCount: unassigned.filter(isRunning).length,
    });
  }
  return groups;
}

/** Search hides empty user-section headers. Unassigned is already omitted
 * when empty by the group helper. */
export function visibleSidebarSectionGroups<T>(
  groups: readonly SidebarProjectGroup<T>[],
  query: string,
): SidebarProjectGroup<T>[] {
  if (!query.trim()) return [...groups];
  return groups.filter((group) => group.bots.length > 0);
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
