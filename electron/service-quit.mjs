// GUI quit vs OS-service teardown. Extracted so vitest can cover
// "Quit does not kill the harness" without constructing BrowserWindow.
//
// [VERIFY] 2026-08-18 HEAD (b0d1ec7): electron/main.mjs before-quit and
// tray Quit both serverProc.kill() the forked harness. After this WP the
// packaged server is owned by the user-session service; GUI quit must
// leave that process up. Tray Show only shows/attaches the window.
// shouldQuitOnLastWindow (electron/background.mjs) is unchanged.
export function guiQuitAction({ ownership } = {}) {
  const ownedByService = ownership === "service" || ownership === "attached";
  return {
    killServer: !ownedByService && ownership === "spawned",
    quitApp: true,
    hideWindow: true,
    stopOsService: false,
  };
}

export function trayShowAction() {
  return { killServer: false, quitApp: false, showWindow: true, forkHarness: false };
}

export function serviceProcessQuitAction() {
  // launchctl bootout / user-service stop / OS logout: tear the child down
  return { killServer: true, quitApp: true, removeSidecar: true, stopOsService: false };
}

export function shouldKillServerOnBeforeQuit({ role, ownership } = {}) {
  if (role === "service") return true;
  if (ownership === "spawned") return true;
  return false;
}
