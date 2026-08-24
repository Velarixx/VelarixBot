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
    title: "No Composio API key yet —",
    action: "add one in App Settings",
  };
}

export interface ComposioSession {
  botId: string;
  userId: string;
  sessionId: string;
}

export const CONNECTOR_HEALTHS = ["connected", "needsAuth", "error", "stale"] as const;
export type ConnectorHealth = (typeof CONNECTOR_HEALTHS)[number];

export interface ConnectorServiceStatus {
  connected?: boolean;
  status?: string;
  health?: ConnectorHealth;
  nextStep?: string;
  identity?: string;
  oauth?: string;
  errorCode?: string;
}

export function isConnectorHealth(value: unknown): value is ConnectorHealth {
  return typeof value === "string" && (CONNECTOR_HEALTHS as readonly string[]).includes(value);
}

export function connectorHealthLabel(health?: string): string {
  if (health === "connected") return "Connected";
  if (health === "needsAuth") return "Needs sign-in";
  if (health === "stale") return "Sign-in expired";
  if (health === "error") return "Error";
  return "";
}

export function connectorHealthTone(health?: string): "success" | "warning" | "danger" | "muted" {
  if (health === "connected") return "success";
  if (health === "stale" || health === "needsAuth") return "warning";
  if (health === "error") return "danger";
  return "muted";
}

export const CONNECTOR_PATHS = {
  catalog: "/api/connectors/catalog",
  sessions: "/api/connectors/sessions",
  revoke: (sessionId: string) => `/api/connectors/sessions/${encodeURIComponent(sessionId)}`,
  status: (slugs: string[], botId?: string) =>
    `/api/connectors?services=${slugs.join(",")}${botId ? `&botId=${encodeURIComponent(botId)}` : ""}`,
  authorize: (slug: string, botId?: string) =>
    `/api/connectors/${slug}/authorize${botId ? `?botId=${encodeURIComponent(botId)}` : ""}`,
  disconnect: (slug: string, botId?: string) =>
    `/api/connectors/${slug}${botId ? `?botId=${encodeURIComponent(botId)}` : ""}`,
  bot: (botId: string) => `/api/bots/${botId}`,
} as const;

export function sessionUserId(botId: string): string {
  return `velarix_${botId}`;
}
