// Install-after-quit plan for unsigned DMG / NSIS updates.
// Pure: no Electron import, no shell:true. Callers inject spawn/fs.
// macOS: wait for GUI exit → stop LaunchAgent → hdiutil + ditto → relaunch.
// Windows: wait for GUI exit → stop user-session service → NSIS /S → relaunch.
import { posix, win32 } from "node:path";

export const INSTALLING_MESSAGE = "Quitting to install the update…";
export const HELPER_FAILED_MESSAGE = "Couldn't start the update helper.";
export const NO_BUNDLE_MESSAGE = "Couldn't find the installed app to replace.";
export const MOUNT_FAILED_MESSAGE = "Couldn't mount the update disk image.";
export const NO_APP_IN_DMG_MESSAGE = "Update disk image did not contain VelarixBot.app.";
export const REPLACE_FAILED_MESSAGE = "Couldn't replace the installed app.";
export const INSTALLER_FAILED_MESSAGE = "The installer did not finish successfully.";
export const WAIT_TIMEOUT_MESSAGE = "Timed out waiting for VelarixBot to quit.";

export function installedBundlePath({ platform, execPath }) {
  const exe = String(execPath ?? "");
  if (!exe) return null;
  if (platform === "darwin") {
    const parts = exe.split("/");
    const appIdx = parts.findLastIndex((p) => p.endsWith(".app"));
    if (appIdx < 0) return null;
    return parts.slice(0, appIdx + 1).join("/");
  }
  if (platform === "win32") {
    const dir = win32.dirname(exe);
    return dir && dir !== "." ? dir : null;
  }
  return null;
}

export function windowsSilentInstallArgs({ installerPath, destDir }) {
  const args = ["/S"];
  if (destDir) args.push(`/D=${destDir}`);
  return { command: installerPath, args };
}

export function macAttachArgs(dmgPath) {
  return { command: "hdiutil", args: ["attach", "-nobrowse", "-plist", dmgPath] };
}

export function macDetachArgs(mountPoint) {
  return { command: "hdiutil", args: ["detach", mountPoint, "-quiet"] };
}

export function macCopyAppArgs(fromApp, toApp) {
  return { command: "ditto", args: [fromApp, toApp] };
}

export function parseHdiutilMountPoint(plistText) {
  const matches = String(plistText ?? "").match(/\/Volumes\/[^<"\n]+/g);
  if (!matches?.length) return null;
  return matches[matches.length - 1].trim();
}

export function appBundleName(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.find((name) => /\.app$/i.test(String(name))) ?? null;
}

export function planInstallAfterQuit({
  platform,
  execPath,
  artifactPath,
  waitPid,
  resultPath,
  stopCommand = null,
  stopArgs = [],
} = {}) {
  const dest = installedBundlePath({ platform, execPath });
  if (!dest) return { ok: false, message: NO_BUNDLE_MESSAGE };
  const relaunch =
    platform === "darwin"
      ? { command: "open", args: ["-n", dest] }
      : { command: execPath, args: [] };
  return {
    ok: true,
    platform,
    waitPid,
    artifactPath,
    destPath: dest,
    destDir: platform === "win32" ? dest : undefined,
    relaunch,
    resultPath,
    stopCommand,
    stopArgs,
  };
}

export function helperLaunch({ execPath, helperPath, planPath, env = {} } = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key === "VELARIX_API_TOKEN" || key === "GITHUB_TOKEN" || key === "GH_TOKEN") continue;
    cleaned[key] = value;
  }
  cleaned.ELECTRON_RUN_AS_NODE = "1";
  return {
    command: execPath,
    args: [helperPath, planPath],
    detached: true,
    stdio: "ignore",
    shell: false,
    env: cleaned,
  };
}

export function processAlive(pid, { kill = process.kill } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit({
  pid,
  isAlive = processAlive,
  now = Date.now,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = 100,
  timeoutMs = 60_000,
} = {}) {
  const start = now();
  while (isAlive(pid)) {
    if (now() - start > timeoutMs) throw new Error(WAIT_TIMEOUT_MESSAGE);
    await delay(intervalMs);
  }
}

export function parseUpdateResult(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      ok: parsed.ok === true,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
    };
  } catch {
    return null;
  }
}

export async function applyUpdate(plan, deps = {}) {
  const {
    waitForExit = waitForProcessExit,
    runArgv,
    listDir,
    writeResult,
  } = deps;
  const write = async (result) => {
    if (typeof writeResult === "function") await writeResult(result);
    return result;
  };
  try {
    await waitForExit({ pid: plan.waitPid, ...deps.wait });
    if (plan.stopCommand && typeof runArgv === "function") {
      await runArgv(plan.stopCommand, plan.stopArgs ?? []);
    }
    if (plan.platform === "darwin") {
      await applyMacUpdate(plan, { runArgv, listDir });
    } else if (plan.platform === "win32") {
      await applyWinUpdate(plan, { runArgv });
    } else {
      throw new Error(`Updates cannot be installed on ${plan.platform}.`);
    }
    const ok = { ok: true };
    await write(ok);
    if (plan.relaunch?.command && typeof runArgv === "function") {
      await runArgv(plan.relaunch.command, plan.relaunch.args ?? [], { detached: true });
    }
    return ok;
  } catch (err) {
    const failed = { ok: false, message: err?.message ?? String(err) };
    await write(failed);
    if (plan.relaunch?.command && typeof runArgv === "function") {
      try {
        await runArgv(plan.relaunch.command, plan.relaunch.args ?? [], { detached: true });
      } catch {
        /* relaunch is best-effort after a failed replace */
      }
    }
    return failed;
  }
}

async function applyMacUpdate(plan, { runArgv, listDir }) {
  const attach = macAttachArgs(plan.artifactPath);
  const mounted = await runArgv(attach.command, attach.args);
  if (mounted?.status !== 0) throw new Error(MOUNT_FAILED_MESSAGE);
  const mount = parseHdiutilMountPoint(mounted.stdout);
  if (!mount) throw new Error(MOUNT_FAILED_MESSAGE);
  try {
    const entries = typeof listDir === "function" ? listDir(mount) : [];
    const appName = appBundleName(entries);
    if (!appName) throw new Error(NO_APP_IN_DMG_MESSAGE);
    const fromApp = posix.join(mount, appName);
    const copy = macCopyAppArgs(fromApp, plan.destPath);
    const copied = await runArgv(copy.command, copy.args);
    if (copied?.status !== 0) throw new Error(REPLACE_FAILED_MESSAGE);
  } finally {
    const detach = macDetachArgs(mount);
    await runArgv(detach.command, detach.args);
  }
}

async function applyWinUpdate(plan, { runArgv }) {
  const install = windowsSilentInstallArgs({
    installerPath: plan.artifactPath,
    destDir: plan.destDir ?? plan.destPath,
  });
  const result = await runArgv(install.command, install.args);
  if (result?.status !== 0) throw new Error(INSTALLER_FAILED_MESSAGE);
}
