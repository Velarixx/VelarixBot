// Explicit quit/update boot suppress for the user-session harness.
// Not a secret: a flag file under ~/.velarixbot so a respawned
// --harness-service process exits 0 without serving (Force Quit /
// unsuccessful-exit must not loop). RunAtLoad must not clear it.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HARNESS_BOOT_SUPPRESS_FILE = "harness-boot-suppress";

export function harnessBootSuppressPath(home = homedir()) {
  return join(home, ".velarixbot", HARNESS_BOOT_SUPPRESS_FILE);
}

export function writeHarnessBootSuppress({
  home = homedir(),
  mkdir = mkdirSync,
  writeFile = writeFileSync,
} = {}) {
  const dest = harnessBootSuppressPath(home);
  mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  writeFile(dest, "quit-all\n", { encoding: "utf8" });
  return dest;
}

export function clearHarnessBootSuppress({ home = homedir(), unlink = unlinkSync } = {}) {
  const dest = harnessBootSuppressPath(home);
  try {
    unlink(dest);
  } catch {
    /* already gone */
  }
  return dest;
}

export function isHarnessBootSuppressed({ home = homedir(), exists = existsSync } = {}) {
  try {
    return exists(harnessBootSuppressPath(home)) === true;
  } catch {
    return false;
  }
}

/** RunAtLoad / --harness-service boot. Never clears the marker. */
export function harnessServiceStartDecision({ suppressPresent } = {}) {
  if (suppressPresent) {
    return { action: "exit-suppressed", exitCode: 0, serve: false, clearSuppress: false };
  }
  return { action: "boot", serve: true, clearSuppress: false };
}

/** Opening the GUI is an explicit start — clear so the host may serve. */
export function guiOpenDecision() {
  return { clearSuppress: true };
}

/** Start-background after an explicit stop — clear, then kickstart/bootstrap. */
export function startBackgroundDecision() {
  return { clearSuppress: true };
}
