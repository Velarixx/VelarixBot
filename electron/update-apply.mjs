// Install-after-quit plan for unsigned DMG / NSIS updates.
// Pure: no Electron import, no shell:true. Callers inject spawn/fs.
// macOS: wait for GUI exit → suppress + bootout → drain bundle executors
// → hdiutil + ditto → clear quarantine → relaunch. Do not ditto while any path under the
// installed .app is still executing (including external-parented proxies).
// Windows: wait for GUI exit → stop user-session service → NSIS /S → relaunch.
import { posix, win32 } from "node:path";

import { writeHarnessBootSuppress } from "./harness-boot-suppress.mjs";

export const INSTALLING_MESSAGE = "Quitting to install the update…";
export const HELPER_FAILED_MESSAGE = "Couldn't start the update helper.";
export const NO_BUNDLE_MESSAGE = "Couldn't find the installed app to replace.";
export const MOUNT_FAILED_MESSAGE = "Couldn't mount the update disk image.";
export const NO_APP_IN_DMG_MESSAGE = "Update disk image did not contain VelarixBot.app.";
export const REPLACE_FAILED_MESSAGE = "Couldn't replace the installed app.";
export const INSTALLER_FAILED_MESSAGE = "The installer did not finish successfully.";
export const WAIT_TIMEOUT_MESSAGE = "Timed out waiting for VelarixBot to quit.";
export const BUNDLE_WAIT_TIMEOUT_MS = 15_000;
export const REPLACE_BLOCKED_MESSAGE = "Replacement did not start.";
export const UPDATE_INTERRUPTED_MESSAGE = "Update was interrupted before install finished.";
export const HELPER_INTERPRETER_NAME = "velarix-update-node";

export function leftoverReplaceMessage({ destPath, leftovers } = {}) {
  const rows = Array.isArray(leftovers) ? leftovers : [];
  const named = rows
    .map((row) => {
      const pid = row?.pid ?? "?";
      const path = row?.command ?? row?.path ?? "";
      return `${pid} (${path})`;
    })
    .filter(Boolean)
    .join("; ");
  const who = named || "unknown VelarixBot process";
  return `Couldn't replace ${destPath || "the installed app"} because these processes are still running: ${who}. ${REPLACE_BLOCKED_MESSAGE}`;
}

export function bootoutFailedMessage({ stopArgs, leftovers } = {}) {
  const target = Array.isArray(stopArgs) && stopArgs.length ? stopArgs.join(" ") : "launchctl bootout";
  const rows = Array.isArray(leftovers) ? leftovers : [];
  if (rows.length) return leftoverReplaceMessage({ destPath: "the installed app", leftovers: rows });
  return `Couldn't stop the background service (${target}). ${REPLACE_BLOCKED_MESSAGE}`;
}

export function macProcessListArgs() {
  return { command: "/bin/ps", args: ["-ax", "-o", "pid=", "-o", "ppid=", "-o", "command="] };
}

export function parsePsCommandLines(stdout) {
  const rows = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

export function commandTouchesBundle(text, bundlePath) {
  const bundle = String(bundlePath ?? "").replace(/\/+$/, "");
  if (!bundle || !text) return false;
  const value = String(text);
  if (value === bundle || value.startsWith(`${bundle}/`)) return true;
  for (const token of value.split(/\s+/)) {
    if (token === bundle || token.startsWith(`${bundle}/`)) return true;
  }
  return false;
}

export function isUpdateHelperProcess(proc) {
  const command = String(proc?.command ?? "");
  return command.includes("update-helper.mjs") || command.includes(HELPER_INTERPRETER_NAME);
}

export function executorsUnderBundle(processes, bundlePath, { excludePids = [] } = {}) {
  const excluded = new Set((excludePids ?? []).map((pid) => Number(pid)));
  return (Array.isArray(processes) ? processes : []).filter((proc) => {
    if (!proc || excluded.has(Number(proc.pid))) return false;
    if (isUpdateHelperProcess(proc)) return false;
    if (commandTouchesBundle(proc.command ?? proc.exe ?? "", bundlePath)) return true;
    return (proc.args ?? []).some((arg) => commandTouchesBundle(arg, bundlePath));
  });
}

export async function waitForBundleExecutorsGone({
  bundlePath,
  listProcesses,
  excludePids = [],
  now = Date.now,
  delay = async () => {},
  intervalMs = 100,
  timeoutMs = BUNDLE_WAIT_TIMEOUT_MS,
} = {}) {
  const start = now();
  for (;;) {
    const listed = await Promise.resolve(typeof listProcesses === "function" ? listProcesses() : []);
    const leftovers = executorsUnderBundle(listed, bundlePath, { excludePids });
    if (leftovers.length === 0) return [];
    if (now() - start > timeoutMs) return leftovers;
    await delay(intervalMs);
  }
}

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

/** After a verified ditto. Clears Gatekeeper quarantine; not signing. */
export function macClearQuarantineArgs(destPath) {
  return { command: "xattr", args: ["-dr", "com.apple.quarantine", destPath] };
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
  home,
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
    home,
  };
}

/** Contents/Frameworks next to Contents/MacOS/<exec>. Electron's stub
 * resolves @executable_path/../Frameworks — a bare binary copy cannot start. */
export function electronFrameworksPath(execPath) {
  const macOSDir = posix.dirname(String(execPath ?? ""));
  if (posix.basename(macOSDir) !== "MacOS") return null;
  return posix.join(posix.dirname(macOSDir), "Frameworks");
}

/** True only for MacOS/<bin> with a Frameworks sibling. A bare execPath copy fails. */
export function isRunnableElectronNodeLayout({ command, frameworksTo } = {}) {
  const exe = String(command ?? "");
  const frameworks = String(frameworksTo ?? "").replace(/\/+$/, "");
  if (!exe || !frameworks) return false;
  const macOSDir = posix.dirname(exe);
  if (posix.basename(macOSDir) !== "MacOS") return false;
  const root = posix.dirname(macOSDir);
  return posix.join(root, "Frameworks") === frameworks && posix.basename(frameworks) === "Frameworks";
}

/** Stage helper scripts + a runnable ELECTRON_RUN_AS_NODE tree outside destPath.
 * Darwin copies execPath into MacOS/ and Contents/Frameworks beside it so the
 * stub can load Electron Framework. A bare execPath copy is not enough.
 * Windows keeps the existing NSIS path (no interpreter copy). */
export function planHelperStaging({ platform, execPath, destPath, helperDir } = {}) {
  const scripts = ["update-helper.mjs", "update-apply.mjs", "harness-boot-suppress.mjs"];
  if (platform === "win32") {
    return { ok: true, command: execPath, copyInterpreter: false, helperDir, scripts };
  }
  if (platform !== "darwin" || !helperDir || !execPath) {
    return { ok: false, message: HELPER_FAILED_MESSAGE };
  }
  if (commandTouchesBundle(helperDir, destPath)) {
    return { ok: false, message: HELPER_FAILED_MESSAGE };
  }
  const frameworksFrom = electronFrameworksPath(execPath);
  if (!frameworksFrom) return { ok: false, message: HELPER_FAILED_MESSAGE };
  const command = posix.join(helperDir, "MacOS", HELPER_INTERPRETER_NAME);
  const frameworksTo = posix.join(helperDir, "Frameworks");
  const cwd = posix.join(helperDir, "MacOS");
  if (commandTouchesBundle(command, destPath) || commandTouchesBundle(frameworksTo, destPath)) {
    return { ok: false, message: HELPER_FAILED_MESSAGE };
  }
  if (!isRunnableElectronNodeLayout({ command, frameworksTo })) {
    return { ok: false, message: HELPER_FAILED_MESSAGE };
  }
  return {
    ok: true,
    command,
    copyInterpreter: true,
    copyFrom: execPath,
    frameworksFrom,
    frameworksTo,
    cwd,
    helperDir,
    scripts,
  };
}

export function helperLaunch({
  command,
  execPath,
  helperPath,
  planPath,
  destPath,
  platform,
  frameworksTo,
  cwd,
  env = {},
} = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key === "VELARIX_API_TOKEN" || key === "GITHUB_TOKEN" || key === "GH_TOKEN") continue;
    cleaned[key] = value;
  }
  cleaned.ELECTRON_RUN_AS_NODE = "1";
  const launchCommand = command || execPath;
  if (!launchCommand || !helperPath || !planPath) {
    return { ok: false, message: HELPER_FAILED_MESSAGE };
  }
  // Darwin: the process ditto overwrites must not be the helper interpreter.
  if (platform !== "win32" && destPath && commandTouchesBundle(launchCommand, destPath)) {
    return { ok: false, message: HELPER_FAILED_MESSAGE };
  }
  if (platform === "darwin") {
    const layoutTo = frameworksTo ?? electronFrameworksPath(launchCommand);
    if (!isRunnableElectronNodeLayout({ command: launchCommand, frameworksTo: layoutTo })) {
      return { ok: false, message: HELPER_FAILED_MESSAGE };
    }
    return {
      ok: true,
      command: launchCommand,
      args: [helperPath, planPath],
      detached: true,
      stdio: "ignore",
      shell: false,
      cwd: cwd ?? posix.dirname(launchCommand),
      env: cleaned,
    };
  }
  return {
    ok: true,
    command: launchCommand,
    args: [helperPath, planPath],
    detached: true,
    stdio: "ignore",
    shell: false,
    env: cleaned,
  };
}

/** Next GUI launch after the helper wrote update-result.json. */
export function nextLaunchUpdaterState({ priorResult, restoredDownload } = {}) {
  if (priorResult?.ok === true) {
    return { status: "idle", downloadedPath: null, clearPersist: true };
  }
  const downloadedPath = restoredDownload?.ok ? restoredDownload.path : null;
  const version = restoredDownload?.ok ? restoredDownload.version : undefined;
  if (priorResult && priorResult.ok === false && priorResult.message) {
    return { status: "error", message: priorResult.message, downloadedPath, version };
  }
  if (downloadedPath) {
    return { status: "downloaded", downloadedPath, version, percent: 100 };
  }
  return { status: "idle", downloadedPath: null };
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
    writeSuppress,
    listProcesses,
    now = Date.now,
    delay,
    timeoutMs = BUNDLE_WAIT_TIMEOUT_MS,
    selfPid = process.pid,
  } = deps;
  const write = async (result) => {
    if (typeof writeResult === "function") await writeResult(result);
    return result;
  };
  try {
    await waitForExit({ pid: plan.waitPid, ...deps.wait });
    if (plan.platform === "darwin") {
      await stopDarwinBeforeReplace(plan, {
        runArgv,
        writeSuppress,
        listProcesses,
        now,
        delay: delay ?? deps.wait?.delay,
        timeoutMs,
        selfPid,
      });
      await applyMacUpdate(plan, { runArgv, listDir });
    } else {
      if (plan.stopCommand && typeof runArgv === "function") {
        await runArgv(plan.stopCommand, plan.stopArgs ?? []);
      }
      if (plan.platform === "win32") {
        await applyWinUpdate(plan, { runArgv });
      } else {
        throw new Error(`Updates cannot be installed on ${plan.platform}.`);
      }
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

async function stopDarwinBeforeReplace(plan, deps) {
  const { runArgv, writeSuppress, listProcesses, now, delay, timeoutMs, selfPid } = deps;
  if (typeof writeSuppress === "function") {
    writeSuppress();
  } else if (plan.home) {
    writeHarnessBootSuppress({ home: plan.home });
  }
  let stopResult = { status: 0 };
  if (plan.stopCommand && typeof runArgv === "function") {
    stopResult = (await runArgv(plan.stopCommand, plan.stopArgs ?? [])) ?? { status: 1 };
  }
  const leftovers = await waitForBundleExecutorsGone({
    bundlePath: plan.destPath,
    listProcesses,
    excludePids: [selfPid],
    now,
    delay,
    timeoutMs,
  });
  if (leftovers.length) {
    throw new Error(leftoverReplaceMessage({ destPath: plan.destPath, leftovers }));
  }
  if (stopResult.status !== 0 && stopResult.status != null) {
    throw new Error(bootoutFailedMessage({ stopArgs: plan.stopArgs, leftovers }));
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
  const quarantine = macClearQuarantineArgs(plan.destPath);
  try {
    await runArgv(quarantine.command, quarantine.args);
  } catch {
    /* clearing quarantine is allowed after a verified copy; not required */
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
