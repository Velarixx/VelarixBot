import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  HELPER_FAILED_MESSAGE,
  INSTALLING_MESSAGE,
  INSTALLER_FAILED_MESSAGE,
  MOUNT_FAILED_MESSAGE,
  NO_APP_IN_DMG_MESSAGE,
  NO_BUNDLE_MESSAGE,
  REPLACE_BLOCKED_MESSAGE,
  REPLACE_FAILED_MESSAGE,
  WAIT_TIMEOUT_MESSAGE,
  appBundleName,
  applyUpdate,
  executorsUnderBundle,
  helperLaunch,
  installedBundlePath,
  leftoverReplaceMessage,
  macAttachArgs,
  macCopyAppArgs,
  macDetachArgs,
  macProcessListArgs,
  parseHdiutilMountPoint,
  parsePsCommandLines,
  parseUpdateResult,
  planInstallAfterQuit,
  processAlive,
  waitForBundleExecutorsGone,
  waitForProcessExit,
  windowsSilentInstallArgs,
} from "./update-apply.mjs";
import { HARNESS_BOOT_SUPPRESS_FILE, isHarnessBootSuppressed } from "./harness-boot-suppress.mjs";
import { runHelper } from "./update-helper.mjs";
import { planServiceStop } from "./service-control.mjs";

const EXE_MAC = "/Applications/VelarixBot.app/Contents/MacOS/VelarixBot";
const EXE_WIN = "C:\\Users\\sam\\AppData\\Local\\Programs\\VelarixBot\\VelarixBot.exe";

describe("install-after-quit plan", () => {
  it("resolves the running .app or per-user Programs install dir", () => {
    expect(installedBundlePath({ platform: "darwin", execPath: EXE_MAC })).toBe("/Applications/VelarixBot.app");
    expect(
      installedBundlePath({
        platform: "darwin",
        execPath: "/Users/sam/Applications/VelarixBot.app/Contents/MacOS/VelarixBot",
      }),
    ).toBe("/Users/sam/Applications/VelarixBot.app");
    expect(installedBundlePath({ platform: "win32", execPath: EXE_WIN })).toBe(
      "C:\\Users\\sam\\AppData\\Local\\Programs\\VelarixBot",
    );
    expect(installedBundlePath({ platform: "linux", execPath: "/opt/VelarixBot" })).toBeNull();
    expect(installedBundlePath({ platform: "darwin", execPath: "" })).toBeNull();
  });

  it("plans a mac helper that stops the LaunchAgent then relaunches with open -n", () => {
    const stop = planServiceStop({ running: true, platform: "darwin", uid: 501 });
    const plan = planInstallAfterQuit({
      platform: "darwin",
      execPath: EXE_MAC,
      artifactPath: "/tmp/VelarixBot-0.3.1-arm64.dmg",
      waitPid: 4242,
      resultPath: "/tmp/update-result.json",
      stopCommand: stop.command,
      stopArgs: stop.args,
    });
    expect(plan.ok).toBe(true);
    expect(plan.destPath).toBe("/Applications/VelarixBot.app");
    expect(plan.relaunch).toEqual({ command: "open", args: ["-n", "/Applications/VelarixBot.app"] });
    expect(plan.stopCommand).toBe("/bin/launchctl");
    expect(plan.stopArgs).toEqual(["bootout", "gui/501/com.velarix.bot.harness"]);
    expect(plan.stopArgs).not.toContain("kickstart");
    expect(planInstallAfterQuit({ platform: "darwin", execPath: "/usr/bin/velarix" }).ok).toBe(false);
    expect(planInstallAfterQuit({ platform: "darwin", execPath: "/usr/bin/velarix" }).message).toBe(NO_BUNDLE_MESSAGE);
  });

  it("plans a Windows silent NSIS install into the existing Local\\Programs dir", () => {
    const stop = planServiceStop({ running: true, platform: "win32" });
    const plan = planInstallAfterQuit({
      platform: "win32",
      execPath: EXE_WIN,
      artifactPath: "C:\\Temp\\VelarixBot-Setup-0.3.1-x64.exe",
      waitPid: 88,
      resultPath: "C:\\Temp\\update-result.json",
      stopCommand: stop.command,
      stopArgs: stop.args,
    });
    expect(plan.ok).toBe(true);
    expect(plan.destDir).toBe("C:\\Users\\sam\\AppData\\Local\\Programs\\VelarixBot");
    expect(plan.relaunch).toEqual({ command: EXE_WIN, args: [] });
    expect(plan.stopArgs).toEqual(["stop", "velarixbot-harness"]);
    const nsis = windowsSilentInstallArgs({
      installerPath: plan.artifactPath,
      destDir: plan.destDir,
    });
    expect(nsis.args[0]).toBe("/S");
    expect(nsis.args.at(-1)).toBe("/D=C:\\Users\\sam\\AppData\\Local\\Programs\\VelarixBot");
  });

  it("launches the helper as argv-only ELECTRON_RUN_AS_NODE without tokens", () => {
    const launch = helperLaunch({
      execPath: EXE_MAC,
      helperPath: "/tmp/update-helper.mjs",
      planPath: "/tmp/update-plan.json",
      env: {
        PATH: "/usr/bin",
        VELARIX_API_TOKEN: "secret-token",
        GITHUB_TOKEN: "ghp_not_logged",
        GH_TOKEN: "gh_not_logged",
        HOME: "/Users/sam",
      },
    });
    expect(launch.command).toBe(EXE_MAC);
    expect(launch.args).toEqual(["/tmp/update-helper.mjs", "/tmp/update-plan.json"]);
    expect(launch.shell).toBe(false);
    expect(launch.detached).toBe(true);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(launch.env.HOME).toBe("/Users/sam");
    expect(JSON.stringify(launch)).not.toContain("secret-token");
    expect(JSON.stringify(launch)).not.toContain("ghp_");
    expect(JSON.stringify(launch)).not.toContain("gh_not_logged");
  });
});

describe("apply after the GUI pid exits", () => {
  it("mounts the DMG, copies the .app, detaches, then relaunches", async () => {
    const calls = [];
    const result = await applyUpdate(
      {
        platform: "darwin",
        waitPid: 9,
        artifactPath: "/tmp/update.dmg",
        destPath: "/Applications/VelarixBot.app",
        stopCommand: "/bin/launchctl",
        stopArgs: ["bootout", "gui/501/com.velarix.bot.harness"],
        relaunch: { command: "open", args: ["-n", "/Applications/VelarixBot.app"] },
      },
      {
        waitForExit: async ({ pid }) => {
          expect(pid).toBe(9);
        },
        listDir: () => ["VelarixBot.app", ".DS_Store"],
        runArgv: async (command, args) => {
          calls.push([command, args]);
          if (command === "hdiutil" && args[0] === "attach") {
            return { status: 0, stdout: "<string>/Volumes/VelarixBot 0.3.1</string>" };
          }
          return { status: 0, stdout: "" };
        },
        writeResult: async (written) => {
          calls.push(["result", written]);
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(calls[0]).toEqual(["/bin/launchctl", ["bootout", "gui/501/com.velarix.bot.harness"]]);
    expect(calls[1]).toEqual(Object.values(macAttachArgs("/tmp/update.dmg")));
    expect(calls[2]).toEqual(Object.values(macCopyAppArgs("/Volumes/VelarixBot 0.3.1/VelarixBot.app", "/Applications/VelarixBot.app")));
    expect(calls[3]).toEqual(Object.values(macDetachArgs("/Volumes/VelarixBot 0.3.1")));
    expect(calls[4]).toEqual(["result", { ok: true }]);
    expect(calls[5]).toEqual(["open", ["-n", "/Applications/VelarixBot.app"]]);
    expect(parseHdiutilMountPoint("no mount")).toBeNull();
    expect(appBundleName(["README.txt"])).toBeNull();
  });

  it("surfaces an actionable error and still relaunches when replace fails", async () => {
    const written = [];
    const result = await applyUpdate(
      {
        platform: "darwin",
        waitPid: 1,
        artifactPath: "/tmp/update.dmg",
        destPath: "/Applications/VelarixBot.app",
        relaunch: { command: "open", args: ["-n", "/Applications/VelarixBot.app"] },
      },
      {
        waitForExit: async () => {},
        listDir: () => ["README.txt"],
        runArgv: async (command, args) => {
          if (command === "hdiutil" && args[0] === "attach") {
            return { status: 0, stdout: "/Volumes/VelarixBot" };
          }
          return { status: 0, stdout: "" };
        },
        writeResult: async (row) => {
          written.push(row);
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe(NO_APP_IN_DMG_MESSAGE);
    expect(written[0]).toEqual({ ok: false, message: NO_APP_IN_DMG_MESSAGE });
  });

  it("runs NSIS silently after the Windows GUI exits", async () => {
    const calls = [];
    const result = await applyUpdate(
      {
        platform: "win32",
        waitPid: 77,
        artifactPath: "C:\\Temp\\Setup.exe",
        destDir: "C:\\Users\\sam\\AppData\\Local\\Programs\\VelarixBot",
        stopCommand: "C:\\Windows\\System32\\sc.exe",
        stopArgs: ["stop", "velarixbot-harness"],
        relaunch: { command: EXE_WIN, args: [] },
      },
      {
        waitForExit: async ({ pid }) => {
          expect(pid).toBe(77);
        },
        runArgv: async (command, args) => {
          calls.push([command, args]);
          return { status: 0, stdout: "" };
        },
        writeResult: async () => {},
      },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(["C:\\Windows\\System32\\sc.exe", ["stop", "velarixbot-harness"]]);
    expect(calls[1]).toEqual(["C:\\Temp\\Setup.exe", ["/S", "/D=C:\\Users\\sam\\AppData\\Local\\Programs\\VelarixBot"]]);
    expect(calls[2]).toEqual([EXE_WIN, []]);
  });

  it("fails closed when hdiutil or NSIS returns nonzero", async () => {
    const dmg = await applyUpdate(
      { platform: "darwin", artifactPath: "/tmp/bad.dmg", destPath: "/Applications/VelarixBot.app" },
      {
        waitForExit: async () => {},
        runArgv: async () => ({ status: 1, stdout: "" }),
        writeResult: async () => {},
      },
    );
    expect(dmg.message).toBe(MOUNT_FAILED_MESSAGE);

    const nsis = await applyUpdate(
      { platform: "win32", artifactPath: "C:\\Temp\\Setup.exe", destDir: "C:\\VelarixBot" },
      {
        waitForExit: async () => {},
        runArgv: async () => ({ status: 2, stdout: "" }),
        writeResult: async () => {},
      },
    );
    expect(nsis.message).toBe(INSTALLER_FAILED_MESSAGE);
  });

  it("waits on the isAlive event and does not use a wall-clock sleep when the pid is already gone", async () => {
    let delays = 0;
    await waitForProcessExit({
      pid: 1,
      isAlive: () => false,
      delay: async () => {
        delays += 1;
      },
    });
    expect(delays).toBe(0);

    let ticks = 0;
    await waitForProcessExit({
      pid: 2,
      isAlive: () => {
        ticks += 1;
        return ticks < 3;
      },
      now: () => ticks * 10,
      timeoutMs: 1000,
      delay: async () => {},
    });
    expect(ticks).toBe(3);

    await expect(
      waitForProcessExit({
        pid: 3,
        isAlive: () => true,
        now: (() => {
          let t = 0;
          return () => {
            t += 50;
            return t;
          };
        })(),
        timeoutMs: 80,
        delay: async () => {},
      }),
    ).rejects.toThrow(WAIT_TIMEOUT_MESSAGE);

    expect(processAlive(0)).toBe(false);
    expect(processAlive(99, { kill: () => {} })).toBe(true);
    expect(
      processAlive(99, {
        kill: () => {
          throw new Error("gone");
        },
      }),
    ).toBe(false);
    expect(parseUpdateResult("not-json")).toBeNull();
    expect(parseUpdateResult(JSON.stringify({ ok: false, message: REPLACE_FAILED_MESSAGE }))).toEqual({
      ok: false,
      message: REPLACE_FAILED_MESSAGE,
    });
    expect(INSTALLING_MESSAGE).toMatch(/quit/i);
    expect(HELPER_FAILED_MESSAGE).toMatch(/helper/i);
  });

  it("does not ditto while a bundle proxy remains, even when PPID is outside the app", async () => {
    const calls = [];
    const proxy = {
      pid: 53001,
      ppid: 88,
      command: "/usr/bin/node /Applications/VelarixBot.app/Contents/Resources/app.asar.unpacked/memory-proxy.js",
    };
    const result = await applyUpdate(
      {
        platform: "darwin",
        waitPid: 9,
        artifactPath: "/tmp/update.dmg",
        destPath: "/Applications/VelarixBot.app",
        stopCommand: "/bin/launchctl",
        stopArgs: ["bootout", "gui/501/com.velarix.bot.harness"],
        relaunch: { command: "open", args: ["-n", "/Applications/VelarixBot.app"] },
      },
      {
        waitForExit: async () => {},
        listProcesses: () => [proxy],
        now: (() => {
          let t = 0;
          return () => {
            t += 100;
            return t;
          };
        })(),
        timeoutMs: 150,
        delay: async () => {},
        runArgv: async (command, args) => {
          calls.push([command, args]);
          return { status: 0, stdout: "" };
        },
        writeResult: async () => {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("53001");
    expect(result.message).toContain("memory-proxy.js");
    expect(result.message).toContain(REPLACE_BLOCKED_MESSAGE);
    expect(calls.some((row) => row[0] === "ditto")).toBe(false);
    expect(calls[0]).toEqual(["/bin/launchctl", ["bootout", "gui/501/com.velarix.bot.harness"]]);
    expect(JSON.stringify(calls)).not.toContain("kickstart");
  });

  it("fails closed when bootout fails and names what is still running", async () => {
    const harness = {
      pid: 52104,
      ppid: 1,
      command: "/Applications/VelarixBot.app/Contents/MacOS/VelarixBot --harness-service",
    };
    const calls = [];
    const result = await applyUpdate(
      {
        platform: "darwin",
        waitPid: 1,
        artifactPath: "/tmp/update.dmg",
        destPath: "/Applications/VelarixBot.app",
        stopCommand: "/bin/launchctl",
        stopArgs: ["bootout", "gui/501/com.velarix.bot.harness"],
        relaunch: { command: "open", args: ["-n", "/Applications/VelarixBot.app"] },
      },
      {
        waitForExit: async () => {},
        listProcesses: () => [harness],
        now: (() => {
          let t = 0;
          return () => {
            t += 80;
            return t;
          };
        })(),
        timeoutMs: 100,
        delay: async () => {},
        runArgv: async (command, args) => {
          calls.push([command, args]);
          return { status: 1, stdout: "" };
        },
        writeResult: async () => {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("52104");
    expect(result.message).toContain("--harness-service");
    expect(result.message).toContain(REPLACE_BLOCKED_MESSAGE);
    expect(calls.some((row) => row[0] === "ditto")).toBe(false);
  });

  it("fails closed when bootout fails even if the process list is already empty", async () => {
    const calls = [];
    const result = await applyUpdate(
      {
        platform: "darwin",
        waitPid: 1,
        artifactPath: "/tmp/update.dmg",
        destPath: "/Applications/VelarixBot.app",
        stopCommand: "/bin/launchctl",
        stopArgs: ["bootout", "gui/501/com.velarix.bot.harness"],
        relaunch: { command: "open", args: ["-n", "/Applications/VelarixBot.app"] },
      },
      {
        waitForExit: async () => {},
        listProcesses: () => [],
        runArgv: async (command, args) => {
          calls.push([command, args]);
          return { status: 5, stdout: "" };
        },
        writeResult: async () => {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("bootout");
    expect(result.message).toContain(REPLACE_BLOCKED_MESSAGE);
    expect(calls.some((row) => row[0] === "ditto")).toBe(false);
  });

  it("harness-enabled update path writes the suppress marker and bootouts before replace", async () => {
    const { mkdtempSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(join(tmpdir(), "velarix-update-home-"));
    mkdirSync(join(home, ".velarixbot"), { recursive: true, mode: 0o700 });
    const calls = [];
    const suppressWrites = [];
    const result = await applyUpdate(
      {
        platform: "darwin",
        waitPid: 9,
        artifactPath: "/tmp/update.dmg",
        destPath: "/Applications/VelarixBot.app",
        stopCommand: "/bin/launchctl",
        stopArgs: ["bootout", "gui/501/com.velarix.bot.harness"],
        relaunch: { command: "open", args: ["-n", "/Applications/VelarixBot.app"] },
        home,
      },
      {
        waitForExit: async () => {},
        listProcesses: () => [],
        writeSuppress: () => {
          suppressWrites.push("marker");
        },
        runArgv: async (command, args) => {
          calls.push([command, args]);
          if (command === "hdiutil" && args[0] === "attach") {
            return { status: 0, stdout: "<string>/Volumes/VelarixBot 0.3.1</string>" };
          }
          return { status: 0, stdout: "" };
        },
        writeResult: async () => {},
        listDir: () => ["VelarixBot.app"],
      },
    );
    expect(result).toEqual({ ok: true });
    expect(suppressWrites).toEqual(["marker"]);
    expect(calls[0]).toEqual(["/bin/launchctl", ["bootout", "gui/501/com.velarix.bot.harness"]]);
    expect(calls.some((row) => row[0] === "ditto")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("kickstart");
    expect(HARNESS_BOOT_SUPPRESS_FILE).toBe("harness-boot-suppress");
    expect(isHarnessBootSuppressed({ home })).toBe(false);
  });

  it("treats external-parented bundle proxies as leftovers and ignores the update helper pid", () => {
    const bundle = "/Applications/VelarixBot.app";
    const parsed = parsePsCommandLines(`
 52104     1 /Applications/VelarixBot.app/Contents/MacOS/VelarixBot --harness-service
 53001    88 /usr/bin/node /Applications/VelarixBot.app/Contents/Resources/agents-proxy.js
 61000     1 /Applications/VelarixBot.app/Contents/MacOS/VelarixBot /tmp/velarixbot-updates/update-helper.mjs /tmp/plan.json
  9999     1 /usr/bin/codex
`);
    expect(macProcessListArgs()).toEqual({
      command: "/bin/ps",
      args: ["-ax", "-o", "pid=", "-o", "ppid=", "-o", "command="],
    });
    expect(macProcessListArgs().args.join(" ")).not.toMatch(/launchctl/);
    const leftovers = executorsUnderBundle(parsed, bundle, { excludePids: [61000] });
    expect(leftovers.map((row) => row.pid)).toEqual([52104, 53001]);
    expect(leftoverReplaceMessage({ destPath: bundle, leftovers })).toContain("53001");
  });

  it("waits on the injected clock until bundle executors drain — no wall-clock sleep", async () => {
    let ticks = 0;
    const leftovers = await waitForBundleExecutorsGone({
      bundlePath: "/Applications/VelarixBot.app",
      listProcesses: () => {
        ticks += 1;
        if (ticks < 3) {
          return [
            {
              pid: 7,
              ppid: 1,
              command: "/Applications/VelarixBot.app/Contents/Resources/workspace-proxy.js",
            },
          ];
        }
        return [];
      },
      now: () => ticks * 10,
      timeoutMs: 1000,
      delay: async () => {},
    });
    expect(leftovers).toEqual([]);
    expect(ticks).toBe(3);
  });

  it("copies the suppress sibling next to the helper and never introduces shell:true", () => {
    const updaterSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "updater.mjs"), "utf8");
    const helperSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "update-helper.mjs"), "utf8");
    const applySrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "update-apply.mjs"), "utf8");
    expect(updaterSrc).toContain("harness-boot-suppress.mjs");
    expect(updaterSrc).toContain("writeHarnessBootSuppress");
    expect(updaterSrc).toMatch(/shell:\s*false/);
    expect(helperSrc).toMatch(/shell:\s*false/);
    expect(helperSrc).not.toMatch(/shell:\s*true/);
    expect(applySrc).toContain("waitForBundleExecutorsGone");
    expect(applySrc).toContain("shell: false");
    expect(applySrc).not.toMatch(/shell:\s*true[^.]/);
  });

  it("runs the helper entry against a plan file without spawning a shell", async () => {
    const { mkdtempSync, writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "velarix-helper-"));
    const planPath = join(dir, "update-plan.json");
    const resultPath = join(dir, "update-result.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        platform: "win32",
        artifactPath: "C:\\Temp\\Setup.exe",
        destDir: "C:\\VelarixBot",
        resultPath,
        relaunch: { command: EXE_WIN, args: [] },
      }),
    );
    const calls = [];
    const result = await runHelper(planPath, {
      wait: { isAlive: () => false },
      runArgv: async (command, args) => {
        calls.push([command, args]);
        return { status: 0, stdout: "" };
      },
      listDir: () => [],
    });
    expect(result.ok).toBe(true);
    expect(calls[0][0]).toBe("C:\\Temp\\Setup.exe");
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({ ok: true });
    unlinkSync(planPath);
    unlinkSync(resultPath);
  });
});
