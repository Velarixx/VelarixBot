// User-session OS service — macOS LaunchAgent (Aqua) and Windows per-user
// service. Not a system daemon, not LocalSystem, not Linux systemd.
//
// [VERIFY] 2026-08-18 HEAD (b0d1ec7) probed facts:
//   - electron-builder.yml ships unsigned DMG + NSIS. No plist, no
//     sc.exe/NSSM, no afterPack service scripts. Installers do not
//     register a harness service today.
//   - launch-at-login is Electron setLoginItemSettings (GUI login item,
//     default off). That opens the window; it is not a user-session
//     service and is not a substitute (FAIL 12).
//   - T2-1 tray Quit / before-quit serverProc.kill()s the forked
//     harness. This module is the start/stop surface that replaces
//     "No Windows service" for the harness only.
//
// Commands are argv arrays. Callers must spawn with shell: false.
// Tests assert the plan; they do not talk to launchctl or sc.exe.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { atomicWritePrivateFile } from "./service-auth.mjs";

export const CANDIDATE_PORTS = [8799, 18799, 28799];
export const SERVICE_FLAG = "--harness-service";
export const LAUNCH_AGENT_LABEL = "com.velarix.bot.harness";
export const LAUNCH_AGENT_PLIST = `${LAUNCH_AGENT_LABEL}.plist`;
export const WINDOWS_SERVICE_NAME = "velarixbot-harness";
export const WINDOWS_SERVICE_TYPE = "userown";
export const HARNESS_SERVICE_ENV = "VELARIX_HARNESS_SERVICE";

export function isHarnessServiceArgv(argv, env = {}) {
  const args = Array.isArray(argv) ? argv : [];
  return args.includes(SERVICE_FLAG) || env[HARNESS_SERVICE_ENV] === "1";
}

export function launchAgentPlistPath(home = homedir()) {
  return posix.join(home, "Library", "LaunchAgents", LAUNCH_AGENT_PLIST);
}

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** User-session LaunchAgent. LimitLoadToSessionType=Aqua — never a
 * LaunchDaemon, never /Library/LaunchDaemons. */
export function renderLaunchAgentPlist({ exePath, label = LAUNCH_AGENT_LABEL } = {}) {
  if (!exePath) throw new Error("LaunchAgent requires the packaged Electron executable");
  const exe = xmlEscape(exePath);
  const id = xmlEscape(label);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${id}</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exe}</string>
    <string>${SERVICE_FLAG}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${HARNESS_SERVICE_ENV}</key>
    <string>1</string>
  </dict>
</dict>
</plist>
`;
}

export function assertUserSessionLaunchAgent(plistXml) {
  const xml = String(plistXml ?? "");
  const ok =
    xml.includes("<string>Aqua</string>") &&
    xml.includes("<key>LimitLoadToSessionType</key>") &&
    !xml.includes("LaunchDaemons") &&
    xml.includes(SERVICE_FLAG) &&
    !/node[^<]*server\/index\.js/.test(xml);
  return ok;
}

export function macGuiDomain(uid) {
  return `gui/${Number(uid)}`;
}

export function macServiceTarget(uid, label = LAUNCH_AGENT_LABEL) {
  return `${macGuiDomain(uid)}/${label}`;
}

export function macBootstrapArgs({ uid, plistPath, label = LAUNCH_AGENT_LABEL }) {
  return { command: "/bin/launchctl", args: ["bootstrap", macGuiDomain(uid), plistPath], label };
}

export function macKickstartArgs({ uid, label = LAUNCH_AGENT_LABEL }) {
  // no -k: kickstart of a live job must not kill+restart (idempotent start)
  return { command: "/bin/launchctl", args: ["kickstart", macServiceTarget(uid, label)], label };
}

export function macBootoutArgs({ uid, label = LAUNCH_AGENT_LABEL }) {
  return { command: "/bin/launchctl", args: ["bootout", macServiceTarget(uid, label)], label };
}

export function windowsScExe(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return win32.join(root, "System32", "sc.exe");
}

/** Per-user user-session service (type=userown). Not LocalSystem, not
 * perMachine, not NSSM. binPath is the packaged Electron exe + flag —
 * never bare `node server/index.js`. Token is minted at process start,
 * never baked into the service command. */
export function windowsCreateArgs({ exePath, name = WINDOWS_SERVICE_NAME, sc = windowsScExe() }) {
  if (!exePath) throw new Error("Windows service requires the packaged Electron executable");
  const binPath = `"${exePath}" ${SERVICE_FLAG}`;
  return {
    command: sc,
    args: [
      "create",
      name,
      "binPath=",
      binPath,
      "start=",
      "auto",
      "type=",
      WINDOWS_SERVICE_TYPE,
      "DisplayName=",
      "VelarixBot harness",
    ],
  };
}

export function windowsStartArgs({ name = WINDOWS_SERVICE_NAME, sc = windowsScExe() } = {}) {
  return { command: sc, args: ["start", name] };
}

export function windowsStopArgs({ name = WINDOWS_SERVICE_NAME, sc = windowsScExe() } = {}) {
  return { command: sc, args: ["stop", name] };
}

export function windowsDeleteArgs({ name = WINDOWS_SERVICE_NAME, sc = windowsScExe() } = {}) {
  return { command: sc, args: ["delete", name] };
}

export function windowsQueryArgs({ name = WINDOWS_SERVICE_NAME, sc = windowsScExe() } = {}) {
  return { command: sc, args: ["query", name] };
}

/** sc query 1060 — the per-user service was never registered (NSIS hook
 * skipped, or create failed). Not a port conflict. */
export function isWindowsServiceMissing(result) {
  if (!result) return true;
  const status = Number(result.status);
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error ?? ""}`;
  if (status === 1060) return true;
  if (/\b1060\b/.test(text)) return true;
  if (/specified service does not exist/i.test(text)) return true;
  return false;
}

export function queryWindowsService({ name = WINDOWS_SERVICE_NAME, spawnSyncFn = spawnSync, env = process.env } = {}) {
  const plan = windowsQueryArgs({ name, sc: windowsScExe(env) });
  return runArgv(plan.command, plan.args, { spawnSyncFn, env });
}

/** Launch the packaged exe as the user-session host. Not LocalSystem,
 * not utilityProcess.fork, not a minted GUI token. */
export function planHarnessHostLaunch({ exePath } = {}) {
  if (!exePath) throw new Error("Harness host launch requires the packaged Electron executable");
  return {
    action: "launch-host",
    reason: "harness-service-process",
    command: exePath,
    args: [SERVICE_FLAG],
    detached: true,
  };
}

export function harnessHostLaunchEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key === "VELARIX_API_TOKEN") continue;
    out[key] = value;
  }
  out[HARNESS_SERVICE_ENV] = "1";
  return out;
}

/** Register + start the OS service, or spawn exe --harness-service when
 * the Windows user service is missing / sc start failed. sc stop is
 * never sufficient to start a host that does not exist. */
export function planEnsureUserSessionHost({
  platform,
  exePath,
  uid,
  serviceMissing = false,
  osStartOk = true,
  recycle = false,
  env = process.env,
} = {}) {
  const steps = [];
  if (recycle && !serviceMissing) steps.push("os-stop");
  steps.push("register");
  if (!serviceMissing) steps.push("os-start");
  if (serviceMissing || !osStartOk) steps.push("launch-host");
  return {
    steps,
    register: planServiceInstall({ platform, uid, exePath, env }),
    osStart: planServiceStart({ running: false, platform, uid, env }),
    osStop: planServiceStop({ running: true, platform, uid, env }),
    launch: exePath ? planHarnessHostLaunch({ exePath }) : null,
    fork: false,
    mintToken: false,
    writeSidecar: false,
  };
}

export async function runEnsureUserSessionHost(input, { register, osStart, osStop, launchHost } = {}) {
  const plan = planEnsureUserSessionHost(input);
  const log = [];
  for (const step of plan.steps) {
    if (step === "register" && typeof register === "function") await register(plan.register);
    if (step === "os-start" && typeof osStart === "function") await osStart(plan.osStart);
    if (step === "os-stop" && typeof osStop === "function") await osStop(plan.osStop);
    if (step === "launch-host" && typeof launchHost === "function") await launchHost(plan.launch);
    log.push({ step });
  }
  return { plan, log };
}

export function isUserSessionWindowsService(plan) {
  const args = plan?.args ?? [];
  const joined = args.join(" ");
  if (/\bLocalSystem\b/i.test(joined)) return false;
  if (/\bperMachine\b/i.test(joined)) return false;
  if (args.includes("type=") && args.includes(WINDOWS_SERVICE_TYPE)) return true;
  return false;
}

export function planServiceStart({ running, platform, uid, plistPath, exePath, env = process.env } = {}) {
  if (running) return { action: "noop", reason: "already-running" };
  if (platform === "darwin") {
    return { action: "start", reason: "kickstart", ...macKickstartArgs({ uid, plistPath }) };
  }
  if (platform === "win32") {
    return { action: "start", reason: "user-service-start", ...windowsStartArgs({ sc: windowsScExe(env) }) };
  }
  return { action: "unsupported", reason: "linux-not-a-ship-target" };
}

export function planServiceStop({ running, platform, uid, env = process.env } = {}) {
  if (!running) return { action: "noop", reason: "already-stopped" };
  if (platform === "darwin") return { action: "stop", reason: "bootout", ...macBootoutArgs({ uid }) };
  if (platform === "win32") {
    return { action: "stop", reason: "user-service-stop", ...windowsStopArgs({ sc: windowsScExe(env) }) };
  }
  return { action: "unsupported", reason: "linux-not-a-ship-target" };
}

export function planServiceInstall({ platform, uid, exePath, plistPath, home = homedir(), env = process.env } = {}) {
  if (platform === "darwin") {
    const dest = plistPath || launchAgentPlistPath(home);
    return {
      action: "install",
      reason: "launch-agent",
      plistPath: dest,
      plist: renderLaunchAgentPlist({ exePath }),
      bootstrap: macBootstrapArgs({ uid, plistPath: dest }),
    };
  }
  if (platform === "win32") {
    return { action: "install", reason: "user-service", ...windowsCreateArgs({ exePath, sc: windowsScExe(env) }) };
  }
  return { action: "unsupported", reason: "linux-not-a-ship-target" };
}

export function planServiceUninstall({ platform, uid, running, env = process.env } = {}) {
  if (platform === "darwin") {
    return {
      action: "uninstall",
      reason: "bootout-and-remove-plist",
      stop: running ? macBootoutArgs({ uid }) : { action: "noop" },
    };
  }
  if (platform === "win32") {
    return {
      action: "uninstall",
      reason: "user-service-delete",
      stop: running ? windowsStopArgs({ sc: windowsScExe(env) }) : { action: "noop" },
      remove: windowsDeleteArgs({ sc: windowsScExe(env) }),
    };
  }
  return { action: "unsupported", reason: "linux-not-a-ship-target" };
}

/** Spawn helper — always shell:false. Secrets never go in argv. */
export function runArgv(command, args, { spawnSyncFn = spawnSync, env } = {}) {
  if (!command) return { status: 1, error: "missing command" };
  return spawnSyncFn(command, args, {
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    ...(env ? { env } : {}),
  });
}

export function applyServicePlan(plan, { spawnSyncFn = spawnSync, env } = {}) {
  if (!plan || plan.action === "noop") return { ok: true, skipped: true, plan };
  if (plan.action === "unsupported") return { ok: false, skipped: true, plan };
  if (!plan.command) return { ok: false, skipped: true, plan };
  const result = runArgv(plan.command, plan.args ?? [], { spawnSyncFn, env });
  return { ok: result.status === 0, status: result.status, plan };
}

/** Stop a leftover occupant by health.pid. sc.exe stop velarixbot-harness
 * is not this — a 0.2.2 GUI-forked server is not the user-session service. */
export function planOccupantStop({ pid, platform } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { action: "noop", reason: "invalid-pid" };
  if (platform === "win32") {
    return {
      action: "stop-occupant",
      reason: "leftover-health-pid",
      command: "taskkill",
      args: ["/pid", String(n), "/T", "/F"],
    };
  }
  return { action: "stop-occupant", reason: "leftover-health-pid", pid: n, signal: "SIGTERM" };
}

export function isScServiceStop(plan) {
  const args = plan?.args ?? [];
  const command = String(plan?.command ?? "");
  return /sc(?:\.exe)?$/i.test(command) && args[0] === "stop" && args.includes(WINDOWS_SERVICE_NAME);
}

export function applyHarnessHostLaunch(plan, { spawnFn, env = process.env } = {}) {
  if (!plan || plan.action !== "launch-host" || !plan.command) return { ok: false, plan };
  if (typeof spawnFn !== "function") return { ok: false, reason: "missing-spawn", plan };
  const child = spawnFn(plan.command, plan.args ?? [], {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
    env: harnessHostLaunchEnv(env),
  });
  try {
    child?.unref?.();
  } catch {
    /* already detached */
  }
  return { ok: true, pid: child?.pid, plan };
}

export function applyOccupantStop(plan, { spawnSyncFn = spawnSync, killFn = process.kill } = {}) {
  if (!plan || plan.action === "noop") return { ok: true, skipped: true, plan };
  if (isScServiceStop(plan)) return { ok: false, reason: "sc-stop-not-occupant", plan };
  if (plan.action !== "stop-occupant") return { ok: false, reason: "not-occupant-stop", plan };
  if (plan.command === "taskkill") {
    const result = runArgv(plan.command, plan.args ?? [], { spawnSyncFn });
    return { ok: result.status === 0, status: result.status, plan };
  }
  if (!plan.pid) return { ok: false, reason: "invalid-pid", plan };
  try {
    killFn(plan.pid, plan.signal);
    return { ok: true, plan };
  } catch (err) {
    if (err && (err.code === "ESRCH" || err.code === "EINVAL")) return { ok: true, alreadyGone: true, plan };
    return { ok: false, plan };
  }
}

export function writeLaunchAgentPlist({ exePath, destPath, home = homedir() } = {}) {
  const dest = destPath || launchAgentPlistPath(home);
  mkdirSync(dirnameSafe(dest), { recursive: true, mode: 0o700 });
  const xml = renderLaunchAgentPlist({ exePath });
  atomicWritePrivateFile(dest, xml);
  return dest;
}

function dirnameSafe(path) {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? "." : path.slice(0, idx);
}

export function removeLaunchAgentPlist({ destPath, home = homedir() } = {}) {
  const dest = destPath || launchAgentPlistPath(home);
  try {
    if (existsSync(dest)) unlinkSync(dest);
  } catch {
    /* already gone */
  }
  return dest;
}

export function parseServiceEnabledPref(raw) {
  if (!raw || typeof raw !== "object" || raw.serviceEnabled === undefined) return null;
  return raw.serviceEnabled === true;
}
