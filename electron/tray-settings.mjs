// Pure tray prefs + badge copy. Extracted so vitest can cover the toggle
// and unread badge without constructing a Tray.
export const TRAY_DEFAULT_ENABLED = true;

export function parseTrayEnabled(raw) {
  if (!raw || typeof raw !== "object") return TRAY_DEFAULT_ENABLED;
  return raw.trayEnabled !== false;
}

export function serializeTrayPrefs(enabled) {
  return JSON.stringify({ trayEnabled: enabled !== false }, null, 2);
}

export function trayBadgeText(unread) {
  const n = Math.floor(Number(unread) || 0);
  if (n < 1) return "";
  if (n > 99) return "99+";
  return String(n);
}

export function trayTooltip(unread) {
  const label = trayBadgeText(unread);
  return label ? `VelarixBot — ${label} unread` : "VelarixBot";
}
