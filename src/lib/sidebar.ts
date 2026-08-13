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
