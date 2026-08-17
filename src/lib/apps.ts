/** Per-bot connected-app enable set. Empty/missing = none — never "all
 * connected apps". Connections stay workspace-wide; this list is the
 * mount gate the hub and Settings Apps card both write. */

export function enabledAppSlugs(bot: { enabledApps?: string[] } | null | undefined): string[] {
  const listed = Array.isArray(bot?.enabledApps)
    ? bot.enabledApps.map((slug) => String(slug).trim().toLowerCase()).filter(Boolean)
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of listed) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

export function toggleEnabledApp(current: string[], slug: string): string[] {
  const id = slug.trim().toLowerCase();
  if (!id) return current;
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

export interface CatalogCard {
  slug: string;
  label: string;
  blurb: string;
  logo?: string | null;
  domain?: string | null;
}

export function filterCatalogCards<T extends { label: string; slug: string; blurb: string }>(
  cards: T[],
  search: string,
): T[] {
  const q = search.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter((c) => `${c.label} ${c.slug} ${c.blurb}`.toLowerCase().includes(q));
}

/** Honest empty copy when Composio is optional / unconfigured. */
export function hubUnconfiguredCopy(): { title: string; action: string } {
  return {
    title: "No Composio Connect key yet —",
    action: "add one in App Settings",
  };
}

export const CONNECTOR_PATHS = {
  catalog: "/api/connectors/catalog",
  status: (slugs: string[]) => `/api/connectors?services=${slugs.join(",")}`,
  authorize: (slug: string) => `/api/connectors/${slug}/authorize`,
  disconnect: (slug: string) => `/api/connectors/${slug}`,
  bot: (botId: string) => `/api/bots/${botId}`,
} as const;
