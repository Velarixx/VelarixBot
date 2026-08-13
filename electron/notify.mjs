// OS toasts for per-bot notifications. Thin IPC: the renderer decides
// via shouldNotify and sends a local title/body; missing permission is a
// silent skip. Click focuses the window and asks the renderer to select
// that bot. No sounds. Works while the window is hidden (close-to-tray).
import { Notification, BrowserWindow, ipcMain, app } from "electron";

export function registerNotifyIpc(getWindow) {
  ipcMain.handle("notify:show", (_event, payload) => {
    const title = typeof payload?.title === "string" ? payload.title : "";
    const body = typeof payload?.body === "string" ? payload.body : "";
    const botId = typeof payload?.botId === "string" ? payload.botId : "";
    if (!title || !Notification.isSupported()) return false;
    try {
      const n = new Notification({ title, body, silent: true });
      n.on("click", () => {
        const win = getWindow?.() ?? BrowserWindow.getAllWindows()[0];
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (process.platform === "darwin") app.focus({ steal: true });
        if (botId) win.webContents.send("notify:click", botId);
      });
      n.show();
      return true;
    } catch {
      return false;
    }
  });
}
