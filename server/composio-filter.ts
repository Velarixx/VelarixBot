// Per-bot Composio toolkit gating. Tool names from Connect look like
// GOOGLEDRIVE_LIST_FILES / GMAIL_SEND_EMAIL; we match the allowed slug
// as a prefix after stripping punctuation. COMPOSIO_MANAGE_* is never
// exposed to a bot — connection management stays on the workspace UI.

export function normalizeToolkit(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseAllowedToolkits(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((s) => String(s))
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  return [...new Set(parts.map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function toolAllowedForApps(toolName: string, allowedSlugs: string[]): boolean {
  const name = String(toolName ?? "").trim();
  if (!name || !allowedSlugs.length) return false;
  if (/^composio_manage/i.test(name)) return false;
  const n = normalizeToolkit(name);
  return allowedSlugs.some((slug) => {
    const s = normalizeToolkit(slug);
    return s.length > 0 && (n === s || n.startsWith(s));
  });
}
