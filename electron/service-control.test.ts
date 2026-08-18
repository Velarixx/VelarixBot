import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CANDIDATE_PORTS,
  HARNESS_SERVICE_ENV,
  LAUNCH_AGENT_LABEL,
  SERVICE_FLAG,
  WINDOWS_SERVICE_NAME,
  WINDOWS_SERVICE_TYPE,
  applyHarnessHostLaunch,
  applyOccupantStop,
  applyServicePlan,
  assertUserSessionLaunchAgent,
  harnessHostLaunchEnv,
  isScServiceStop,
  isWindowsServiceMissing,
  isHarnessServiceArgv,
  isUserSessionWindowsService,
  launchAgentPlistPath,
  macBootstrapArgs,
  macBootoutArgs,
  macKickstartArgs,
  parseServiceEnabledPref,
  planEnsureUserSessionHost,
  planHarnessHostLaunch,
  planOccupantStop,
  planServiceInstall,
  planServiceStart,
  planServiceStop,
  planServiceUninstall,
  renderLaunchAgentPlist,
  windowsCreateArgs,
  windowsDeleteArgs,
  windowsQueryArgs,
  windowsStartArgs,
  windowsStopArgs,
} from "./service-control.mjs";

const EXE_MAC = "/Applications/VelarixBot.app/Contents/MacOS/VelarixBot";
const EXE_WIN = "C:\\Users\\sam\\AppData\\Local\\Programs\\VelarixBot\\VelarixBot.exe";

describe("user-session service control", () => {
  it("detects the service flag from argv or env — never from a token", () => {
    expect(isHarnessServiceArgv(["--harness-service"], {})).toBe(true);
    expect(isHarnessServiceArgv([], { [HARNESS_SERVICE_ENV]: "1" })).toBe(true);
    expect(isHarnessServiceArgv(["--gui"], {})).toBe(false);
    expect(SERVICE_FLAG).toBe("--harness-service");
  });

  it("renders an Aqua LaunchAgent that is not a LaunchDaemon and is not bare node", () => {
    const xml = renderLaunchAgentPlist({ exePath: EXE_MAC });
    expect(assertUserSessionLaunchAgent(xml)).toBe(true);
    expect(xml).toContain("<key>LimitLoadToSessionType</key>");
    expect(xml).toContain("<string>Aqua</string>");
    expect(xml).toContain(LAUNCH_AGENT_LABEL);
    expect(xml).toContain(EXE_MAC);
    expect(xml).toContain(SERVICE_FLAG);
    expect(xml).not.toMatch(/LaunchDaemons/);
    expect(xml).not.toMatch(/node/);
    expect(xml).not.toMatch(/server\/index\.js/);
    expect(xml).not.toMatch(/VELARIX_API_TOKEN|secret:\/\//);
    expect(launchAgentPlistPath("/Users/sam")).toBe(
      `/Users/sam/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`,
    );
    expect(launchAgentPlistPath("/Users/sam")).not.toMatch(/LaunchDaemons/);
  });

  it("XML-escapes the executable path in the plist", () => {
    const xml = renderLaunchAgentPlist({ exePath: "/tmp/a&b<c>.app/Contents/MacOS/VelarixBot" });
    expect(xml).toContain("/tmp/a&amp;b&lt;c&gt;.app/Contents/MacOS/VelarixBot");
    expect(xml).not.toContain("/tmp/a&b<c>");
  });

  it("builds launchctl bootstrap / kickstart / bootout argv without -k and without shell", () => {
    expect(macBootstrapArgs({ uid: 501, plistPath: "/Users/sam/Library/LaunchAgents/x.plist" })).toEqual({
      command: "/bin/launchctl",
      args: ["bootstrap", "gui/501", "/Users/sam/Library/LaunchAgents/x.plist"],
      label: LAUNCH_AGENT_LABEL,
    });
    const kick = macKickstartArgs({ uid: 501 });
    expect(kick.command).toBe("/bin/launchctl");
    expect(kick.args).toEqual(["kickstart", `gui/501/${LAUNCH_AGENT_LABEL}`]);
    expect(kick.args).not.toContain("-k");
    expect(macBootoutArgs({ uid: 501 }).args).toEqual(["bootout", `gui/501/${LAUNCH_AGENT_LABEL}`]);
  });

  it("registers a per-user Windows service (userown), not LocalSystem / perMachine / node", () => {
    const create = windowsCreateArgs({ exePath: EXE_WIN, sc: "C:\\Windows\\System32\\sc.exe" });
    expect(create.args[0]).toBe("create");
    expect(create.args).toContain(WINDOWS_SERVICE_NAME);
    expect(create.args).toContain("type=");
    expect(create.args).toContain(WINDOWS_SERVICE_TYPE);
    expect(create.args).toContain("start=");
    expect(create.args).toContain("auto");
    expect(create.args.join(" ")).toContain(EXE_WIN);
    expect(create.args.join(" ")).toContain(SERVICE_FLAG);
    expect(create.args.join(" ")).not.toMatch(/LocalSystem|perMachine|NSSM|node\.exe/i);
    expect(isUserSessionWindowsService(create)).toBe(true);
    expect(windowsStartArgs({ sc: "sc.exe" }).args).toEqual(["start", WINDOWS_SERVICE_NAME]);
    expect(windowsStopArgs({ sc: "sc.exe" }).args).toEqual(["stop", WINDOWS_SERVICE_NAME]);
    expect(windowsDeleteArgs({ sc: "sc.exe" }).args).toEqual(["delete", WINDOWS_SERVICE_NAME]);
    expect(windowsQueryArgs({ sc: "sc.exe" }).args).toEqual(["query", WINDOWS_SERVICE_NAME]);
  });

  it("treats sc query 1060 as a missing user service, not a port conflict", () => {
    expect(isWindowsServiceMissing(null)).toBe(true);
    expect(isWindowsServiceMissing({ status: 1060, stdout: "", stderr: "" })).toBe(true);
    expect(
      isWindowsServiceMissing({
        status: 1,
        stdout: "",
        stderr: "The specified service does not exist as an installed service.\r\n",
      }),
    ).toBe(true);
    expect(isWindowsServiceMissing({ status: 0, stdout: "STATE : 4 RUNNING" })).toBe(false);
  });

  it("launches exe --harness-service without a token and without LocalSystem", () => {
    const launch = planHarnessHostLaunch({ exePath: EXE_WIN });
    expect(launch).toEqual({
      action: "launch-host",
      reason: "harness-service-process",
      command: EXE_WIN,
      args: [SERVICE_FLAG],
      detached: true,
    });
    expect(launch.args.join(" ")).not.toMatch(/LocalSystem|node\.exe/i);
    const env = harnessHostLaunchEnv({
      PATH: "C:\\Windows\\System32",
      VELARIX_API_TOKEN: "ab".repeat(32),
    });
    expect(env.VELARIX_HARNESS_SERVICE).toBe("1");
    expect(env).not.toHaveProperty("VELARIX_API_TOKEN");
    const spawned: Array<[string, string[], { shell?: boolean; detached?: boolean; env?: Record<string, string> }]> =
      [];
    const child = {
      pid: 4242,
      unref() {
        return undefined;
      },
    };
    const result = applyHarnessHostLaunch(launch, {
      env: { PATH: "C:\\Windows\\System32", VELARIX_API_TOKEN: "ab".repeat(32) },
      spawnFn: (command: string, args: string[], opts: { shell?: boolean; detached?: boolean; env?: Record<string, string> }) => {
        spawned.push([command, args, opts]);
        return child;
      },
    });
    expect(result.ok).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0][0]).toBe(EXE_WIN);
    expect(spawned[0][1]).toEqual(["--harness-service"]);
    expect(spawned[0][2].shell).toBe(false);
    expect(spawned[0][2].detached).toBe(true);
    expect(spawned[0][2].env).not.toHaveProperty("VELARIX_API_TOKEN");
    expect(spawned[0][2].env?.VELARIX_HARNESS_SERVICE).toBe("1");
  });

  it("empty + missing Windows service plans register then launch-host, not sc stop only", () => {
    const missing = planEnsureUserSessionHost({
      platform: "win32",
      exePath: EXE_WIN,
      serviceMissing: true,
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(missing.steps).toEqual(["register", "launch-host"]);
    expect(isUserSessionWindowsService(missing.register)).toBe(true);
    expect(missing.launch.args).toEqual([SERVICE_FLAG]);
    expect(missing.fork).toBe(false);
    expect(missing.mintToken).toBe(false);
    expect(missing.writeSidecar).toBe(false);

    const present = planEnsureUserSessionHost({
      platform: "win32",
      exePath: EXE_WIN,
      serviceMissing: false,
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(present.steps).toEqual(["register", "os-start"]);
    expect(present.osStart.args).toEqual(["start", WINDOWS_SERVICE_NAME]);
  });

  it("start/stop are idempotent — already-running start and already-stopped stop do not spawn", () => {
    const calls: Array<[string, string[]]> = [];
    const spawnSyncFn = (command: string, args: string[]) => {
      calls.push([command, args]);
      return { status: 0 };
    };
    const started = planServiceStart({ running: true, platform: "darwin", uid: 501 });
    expect(started).toEqual({ action: "noop", reason: "already-running" });
    expect(applyServicePlan(started, { spawnSyncFn }).skipped).toBe(true);

    const stopped = planServiceStop({ running: false, platform: "win32" });
    expect(stopped).toEqual({ action: "noop", reason: "already-stopped" });
    expect(applyServicePlan(stopped, { spawnSyncFn }).skipped).toBe(true);
    expect(calls).toEqual([]);

    const kick = planServiceStart({ running: false, platform: "darwin", uid: 501 });
    expect(kick.action).toBe("start");
    expect(applyServicePlan(kick, { spawnSyncFn }).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][1][0]).toBe("kickstart");

    const bootout = planServiceStop({ running: true, platform: "darwin", uid: 501 });
    expect(bootout.action).toBe("stop");
    expect(applyServicePlan(bootout, { spawnSyncFn }).ok).toBe(true);
    expect(calls[1][1][0]).toBe("bootout");

    const winStart = planServiceStart({
      running: false,
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(winStart.reason).toBe("user-service-start");
    const winStop = planServiceStop({ running: true, platform: "win32", env: { SystemRoot: "C:\\Windows" } });
    expect(winStop.reason).toBe("user-service-stop");
  });

  it("does not invent a Linux systemd unit", () => {
    expect(planServiceStart({ running: false, platform: "linux" }).action).toBe("unsupported");
    expect(planServiceStop({ running: true, platform: "linux" }).reason).toBe("linux-not-a-ship-target");
    expect(planServiceInstall({ platform: "linux", exePath: "/usr/bin/velarixbot" }).action).toBe(
      "unsupported",
    );
    expect(planServiceUninstall({ platform: "linux" }).action).toBe("unsupported");
  });

  it("install plans write an Aqua plist or a userown service — token never in argv", () => {
    const mac = planServiceInstall({
      platform: "darwin",
      uid: 501,
      exePath: EXE_MAC,
      home: "/Users/sam",
    });
    expect(mac.action).toBe("install");
    expect(assertUserSessionLaunchAgent(mac.plist)).toBe(true);
    expect(JSON.stringify(mac)).not.toMatch(/[0-9a-f]{64}/);
    expect(mac.bootstrap.args[0]).toBe("bootstrap");

    const win = planServiceInstall({
      platform: "win32",
      exePath: EXE_WIN,
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(isUserSessionWindowsService(win)).toBe(true);
    expect(JSON.stringify(win)).not.toMatch(/VELARIX_API_TOKEN/);
  });

  it("keeps the candidate port list aligned with the packaged probe", () => {
    expect(CANDIDATE_PORTS).toEqual([8799, 18799, 28799]);
  });

  it("pins the shipped LaunchAgent template, NSIS hooks, and builder include", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const plist = readFileSync(join(root, "build", "com.velarix.bot.harness.plist"), "utf8");
    const nsh = readFileSync(join(root, "build", "installer.nsh"), "utf8");
    const yml = readFileSync(join(root, "electron-builder.yml"), "utf8");
    const install = readFileSync(join(root, "INTERNAL_INSTALL.md"), "utf8");
    expect(assertUserSessionLaunchAgent(plist)).toBe(true);
    expect(plist).toContain("LimitLoadToSessionType");
    expect(nsh).toMatch(/type=\s*userown/);
    expect(nsh).toContain("--harness-service");
    expect(nsh).toMatch(/sc\.exe" stop velarixbot-harness/);
    expect(nsh).toMatch(/sc\.exe" delete velarixbot-harness/);
    const nshCommands = nsh
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith(";"))
      .join("\n");
    expect(nshCommands).not.toMatch(/LocalSystem|NSSM/i);
    expect(nshCommands).toMatch(/type=\s*userown/);
    expect(yml).toMatch(/include:\s*build\/installer\.nsh/);
    expect(yml).toMatch(/perMachine:\s*false/);
    expect(yml).toMatch(/identity:\s*"-"\s*/);
    expect(yml).toMatch(/notarize:\s*false/);
    expect(install).toMatch(/launchctl bootout/);
    expect(install).toMatch(/sc\.exe stop velarixbot-harness/);
    expect(install).toMatch(/Library\/LaunchAgents/);
    expect(install).not.toMatch(/LaunchDaemons/);
  });

  it("stops a leftover occupant by health.pid — not sc.exe stop velarixbot-harness", () => {
    const posix = planOccupantStop({ pid: 8800, platform: "darwin" });
    expect(posix).toEqual({ action: "stop-occupant", reason: "leftover-health-pid", pid: 8800, signal: "SIGTERM" });
    expect(isScServiceStop(posix)).toBe(false);
    const killed: Array<[number, string]> = [];
    expect(applyOccupantStop(posix, { killFn: (pid, signal) => killed.push([pid, String(signal)]) }).ok).toBe(true);
    expect(killed).toEqual([[8800, "SIGTERM"]]);

    const calls: Array<[string, string[]]> = [];
    const win = planOccupantStop({ pid: 8800, platform: "win32" });
    expect(win.command).toBe("taskkill");
    expect(win.args).toEqual(["/pid", "8800", "/T", "/F"]);
    expect(isScServiceStop(win)).toBe(false);
    const spawnSyncFn = (command: string, args: string[]) => {
      calls.push([command, args]);
      return { status: 0 };
    };
    expect(applyOccupantStop(win, { spawnSyncFn }).ok).toBe(true);
    expect(calls).toEqual([["taskkill", ["/pid", "8800", "/T", "/F"]]]);
    expect(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "service-control.mjs"), "utf8")).toMatch(
      /shell:\s*false/,
    );

    const scStop = windowsStopArgs({ sc: "C:\\Windows\\System32\\sc.exe" });
    expect(isScServiceStop(scStop)).toBe(true);
    expect(applyOccupantStop(scStop).ok).toBe(false);
    expect(applyOccupantStop(scStop).reason).toBe("sc-stop-not-occupant");
    expect(planOccupantStop({ pid: 0, platform: "win32" }).action).toBe("noop");
  });

  it("treats an unset serviceEnabled pref as null (first packaged launch enables)", () => {
    expect(parseServiceEnabledPref(null)).toBeNull();
    expect(parseServiceEnabledPref({})).toBeNull();
    expect(parseServiceEnabledPref({ serviceEnabled: true })).toBe(true);
    expect(parseServiceEnabledPref({ serviceEnabled: false })).toBe(false);
  });
});
