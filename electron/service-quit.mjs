// GUI quit vs OS-service teardown. Extracted so vitest can cover
// "Quit does not kill the harness" without constructing BrowserWindow.
//
// Closing the window / tray Quit leaves the LaunchAgent up (background
// policy). Quit All / Stop Background Service is the explicit stop:
// write the boot-suppress marker, then launchctl bootout — never
// kickstart, never "kill the pid and leave the job loaded".
import { planServiceStop } from "./service-control.mjs";

export function guiQuitAction({ ownership } = {}) {
  const ownedByService = ownership === "service" || ownership === "attached";
  return {
    killServer: !ownedByService && ownership === "spawned",
    quitApp: true,
    hideWindow: true,
    stopOsService: false,
    writeSuppress: false,
  };
}

export function trayShowAction() {
  return { killServer: false, quitApp: false, showWindow: true, forkHarness: false };
}

export function serviceProcessQuitAction() {
  // launchctl bootout / user-service stop / OS logout: tear the child down
  return { killServer: true, quitApp: true, removeSidecar: true, stopOsService: false, writeSuppress: false };
}

export function shouldKillServerOnBeforeQuit({ role, ownership } = {}) {
  if (role === "service") return true;
  if (ownership === "spawned") return true;
  return false;
}

export function quitAllAction({ platform, uid, running = true, env } = {}) {
  const stop = planServiceStop({ running, platform, uid, env });
  return {
    killServer: true,
    quitApp: true,
    hideWindow: false,
    stopOsService: stop.action === "stop",
    writeSuppress: true,
    kickstart: false,
    stop,
  };
}

export function applyQuitAllPlan(action, { writeSuppress, applyStop } = {}) {
  if (action?.writeSuppress && typeof writeSuppress === "function") writeSuppress();
  if (action?.stopOsService && action.stop && typeof applyStop === "function") {
    applyStop(action.stop);
  }
  return { kickstart: false, quitApp: action?.quitApp === true };
}
