// VelarixBot uses manual updates from its private GitHub Releases page.
// Embedding a GitHub token in the desktop app would expose repository access,
// so the updater bridge intentionally remains dormant for internal builds.
import { ipcMain } from "electron";

const state = { status: "idle" };

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", () => undefined);
  ipcMain.handle("update:download", () => undefined);
  ipcMain.handle("update:install", () => undefined);
}

export function startUpdater(_mainWindow) {
  // updates are installed manually from the private GitHub release
}
