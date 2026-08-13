// Pure close-to-hide policy for the desktop shell. Extracted so vitest can
// cover it without constructing a Tray or BrowserWindow.
//
// Tray on → last window hides, harness keeps running on every platform.
// Tray off → macOS stays in Dock (historical default); Windows/Linux quit.
export function shouldQuitOnLastWindow({ platform, trayEnabled }) {
  if (trayEnabled) return false;
  return platform !== "darwin";
}
