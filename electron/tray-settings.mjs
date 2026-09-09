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

export function trayTooltip(unread, { backgroundRunning } = {}) {
  const label = trayBadgeText(unread);
  const base = label ? `VelarixBot — ${label} unread` : "VelarixBot";
  if (backgroundRunning) {
    return label ? `${base} — background service running` : "VelarixBot — background service running";
  }
  return base;
}

export const BACKGROUND_RUNNING_COPY = "Background service is still running";
export const QUIT_ALL_LABEL = "Quit All / Stop Background Service";

export function trayMenuSpec({ backgroundRunning = true } = {}) {
  const items = [
    { id: "show", label: "Show", action: "show" },
    { type: "separator" },
  ];
  if (backgroundRunning) {
    items.push({ id: "background-status", label: BACKGROUND_RUNNING_COPY, enabled: false });
  }
  items.push(
    { id: "quit-all", label: QUIT_ALL_LABEL, action: "quit-all" },
    { type: "separator" },
    { id: "quit", label: "Quit", action: "gui-quit" },
  );
  return items;
}
