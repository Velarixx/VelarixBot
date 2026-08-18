// Attach-vs-spawn policy for the packaged desktop shell.
//
// [VERIFY] 2026-08-18 HEAD (b0d1ec7) probed facts:
//   - startServerOn probes 8799 → 18799 → 28799 and adopts only
//     app==="velarixbot" && pid===proc.pid && static. Pid-equals-child is
//     spawn-only: it proves the child we just forked, not that a listener
//     is the user-session service.
//   - A foreign 8799 (same API shape, different pid) falls through and
//     forks a second harness. Two processes then tick / write
//     ~/.velarixbot — the attach bug this module exists to close.
//   - /api/health is the identity probe (app,pid,static,stamp). Attach
//     must still require app==="velarixbot" and static. The extra "ours"
//     check is the local sidecar pid, not "we just forked this pid".
//
// Actions:
//   attach   — bind the window to this port; do not fork
//   spawn    — empty port; the *service host* may fork (never the GUI)
//   skip     — non-ours occupant (other app); try the next candidate port
//   replace  — leftover 0.2.2-shaped velarixbot (static, sidecar missing
//              or pid mismatch). Stop health.pid, then start the service
//              and attach. Do not adopt; do not second-fleet; do not fork
//              from the packaged GUI.
//   conflict — a velarixbot listener we must not adopt and must not
//              second-fleet (dev/headless node, static:false)
import { CANDIDATE_PORTS } from "./service-control.mjs";
import { healthWithoutSecrets } from "./service-auth.mjs";

export { CANDIDATE_PORTS };

export function isOursHealth(body) {
  return Boolean(body && body.app === "velarixbot" && body.static === true);
}

/** Spawn-only identity: the child we just forked. Not used for attach. */
export function isSpawnedChildHealth(body, childPid) {
  return isOursHealth(body) && Number(body.pid) === Number(childPid) && Number(childPid) > 0;
}

/** Attach identity: health is ours AND the local sidecar names that pid.
 * Missing/mismatched sidecar → not attach (do not adopt a leftover or
 * foreign velarixbot). */
export function isAttachableOurs(body, sidecar) {
  if (!isOursHealth(body) || !sidecar) return false;
  return Number(body.pid) === Number(sidecar.pid) && Number(sidecar.pid) > 0;
}

/** 0.2.2 leftover: packaged static velarixbot whose sidecar is missing
 * or names a different pid. Stop health.pid; do not adopt. */
export function leftoverOccupantPid(health, sidecar) {
  if (!isOursHealth(health) || isAttachableOurs(health, sidecar)) return null;
  const pid = Number(health.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function decideListenerAction({ health, sidecar, childPid = null }) {
  if (!health) return { action: "spawn", reason: "empty" };
  if (isAttachableOurs(health, sidecar)) return { action: "attach", reason: "sidecar-pid" };
  if (childPid != null && isSpawnedChildHealth(health, childPid)) {
    return { action: "spawn-owned", reason: "child-pid" };
  }
  if (health.app === "velarixbot") {
    if (!health.static) return { action: "conflict", reason: "velarixbot-not-static" };
    const pid = leftoverOccupantPid(health, sidecar);
    if (pid) return { action: "replace", reason: "velarixbot-leftover", pid };
    return { action: "conflict", reason: "velarixbot-not-ours" };
  }
  return { action: "skip", reason: "foreign" };
}

/** Packaged GUI: attach to ours; never fork; replace a leftover
 * velarixbot by health.pid; start the OS service when every candidate
 * is empty; refuse a second fleet on a velarixbot we must not touch. */
export function decidePackagedGuiAction(results) {
  const list = Array.isArray(results) ? results : [];
  let firstReplace = null;
  let firstConflict = null;
  for (const row of list) {
    const decided = decideListenerAction(row);
    if (decided.action === "attach") {
      return { action: "attach", port: row.port, reason: decided.reason };
    }
    if (decided.action === "replace" && !firstReplace) {
      firstReplace = { action: "replace", port: row.port, reason: decided.reason, pid: decided.pid };
    }
    if (decided.action === "conflict" && !firstConflict) {
      firstConflict = { action: "conflict", port: row.port, reason: decided.reason };
    }
  }
  if (firstReplace) return firstReplace;
  if (firstConflict) return firstConflict;
  if (list.length === 0 || list.every((row) => decideListenerAction(row).action === "spawn")) {
    return { action: "start-service", reason: "empty" };
  }
  if (list.every((row) => decideListenerAction(row).action === "skip" || decideListenerAction(row).action === "spawn")) {
    return { action: "start-service", reason: "fallback-port" };
  }
  return { action: "conflict", reason: "unresolved" };
}

/** --harness-service host: fork only when empty; replace leftover then
 * spawn (never sit idle with serverReady=false); exit-0 if we already
 * own the listener (idempotent, no double fork); never adopt foreign. */
export function decideServiceHostAction(results) {
  const list = Array.isArray(results) ? results : [];
  let firstReplace = null;
  let firstSpawn = null;
  for (const row of list) {
    const decided = decideListenerAction(row);
    if (decided.action === "attach" || decided.action === "spawn-owned") {
      return { action: "already-running", port: row.port, reason: decided.reason };
    }
    if (decided.action === "replace" && !firstReplace) {
      firstReplace = { action: "replace", port: row.port, reason: decided.reason, pid: decided.pid };
    }
    if (decided.action === "conflict") {
      return { action: "conflict", port: row.port, reason: decided.reason };
    }
    if (decided.action === "spawn" && !firstSpawn) {
      firstSpawn = { action: "spawn", port: row.port, reason: decided.reason };
    }
  }
  if (firstReplace) return firstReplace;
  if (firstSpawn) return firstSpawn;
  return { action: "conflict", reason: "no-port" };
}

export function shouldForkHarness(decision) {
  return decision?.action === "spawn";
}

const GUI_BOOT_SAFE = { fork: false, mintToken: false, writeSidecar: false };

/** Packaged GUI boot steps. Leftover → stop health.pid, then ensure the
 * user-session host (register / sc start / exe --harness-service when
 * the Windows service is missing). Empty ports + missing service is
 * ensure-host, not ERROR_PAGE. Never fork, never mint, never write the
 * sidecar. */
export function planPackagedGuiBoot(decision, { serviceMissing = false } = {}) {
  if (decision?.action === "attach") {
    return { ...GUI_BOOT_SAFE, steps: ["attach"], page: "app", stopCard: false, serviceMissing };
  }
  if (decision?.action === "replace") {
    return {
      ...GUI_BOOT_SAFE,
      steps: ["stop-occupant", "ensure-host", "attach"],
      pid: decision.pid,
      page: "stop-card",
      stopCard: true,
      serviceMissing,
    };
  }
  if (decision?.action === "start-service") {
    return {
      ...GUI_BOOT_SAFE,
      steps: ["ensure-host", "attach"],
      page: "app",
      stopCard: false,
      serviceMissing,
    };
  }
  return { ...GUI_BOOT_SAFE, steps: ["error-page"], page: "error-page", stopCard: false, serviceMissing };
}

/** Service host boot steps. Leftover → kill health.pid then spawn so
 * the host is not left running with serverReady=false. */
export function planServiceHostBoot(decision) {
  if (decision?.action === "already-running") {
    return { steps: ["exit-0"], fork: false, idleEmpty: false };
  }
  if (decision?.action === "replace") {
    return { steps: ["stop-occupant", "spawn"], pid: decision.pid, fork: true, idleEmpty: false };
  }
  if (decision?.action === "spawn") {
    return { steps: ["spawn"], fork: true, idleEmpty: false };
  }
  return { steps: ["idle-conflict"], fork: false, idleEmpty: true };
}

export async function runPackagedGuiBoot(
  decision,
  { stopOccupant, ensureHost, attach, serviceMissing = false } = {},
) {
  const plan = planPackagedGuiBoot(decision, { serviceMissing });
  const log = [];
  for (const step of plan.steps) {
    if (step === "stop-occupant") {
      if (typeof stopOccupant === "function") await stopOccupant(plan.pid);
      log.push({ step, pid: plan.pid });
    } else if (step === "ensure-host") {
      if (typeof ensureHost === "function") await ensureHost({ serviceMissing: plan.serviceMissing });
      log.push({ step, serviceMissing: plan.serviceMissing });
    } else if (step === "attach") {
      const found = typeof attach === "function" ? await attach() : null;
      log.push({ step });
      return { plan, log, found };
    } else if (step === "error-page") {
      log.push({ step });
      return { plan, log, found: null };
    }
  }
  return { plan, log, found: null };
}

export async function runServiceHostBoot(decision, { stopOccupant, spawn } = {}) {
  const plan = planServiceHostBoot(decision);
  const log = [];
  for (const step of plan.steps) {
    if (step === "stop-occupant") {
      if (typeof stopOccupant === "function") await stopOccupant(plan.pid);
      log.push({ step, pid: plan.pid });
    } else if (step === "spawn") {
      const spawned = typeof spawn === "function" ? await spawn() : false;
      log.push({ step });
      return { plan, log, spawned: Boolean(spawned), idleEmpty: false };
    } else if (step === "exit-0") {
      log.push({ step });
      return { plan, log, spawned: false, idleEmpty: false };
    } else if (step === "idle-conflict") {
      log.push({ step });
      return { plan, log, spawned: false, idleEmpty: true };
    }
  }
  return { plan, log, spawned: false, idleEmpty: plan.idleEmpty };
}

/** Production wait uses a real timer; tests inject a no-op sleep so the
 * suite never `await`s wall-clock time. */
export async function waitForAttachable({
  probe,
  readSidecar,
  ports = CANDIDATE_PORTS,
  attempts = 40,
  sleep = async () => {},
} = {}) {
  if (typeof probe !== "function") return null;
  for (let i = 0; i < attempts; i++) {
    const sidecar = typeof readSidecar === "function" ? readSidecar() : null;
    for (const port of ports) {
      const health = await probe(port);
      if (isAttachableOurs(health, sidecar)) {
        return { port, health: healthWithoutSecrets(health), sidecar };
      }
    }
    if (i + 1 < attempts) await sleep();
  }
  return null;
}

export function probeResultsFromMap(byPort, sidecar) {
  return CANDIDATE_PORTS.map((port) => ({
    port,
    health: byPort?.[port] ?? null,
    sidecar,
  }));
}
