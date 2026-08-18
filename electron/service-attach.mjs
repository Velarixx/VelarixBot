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
//   conflict — a velarixbot listener we must not adopt and must not
//              second-fleet (dev/headless node, stale pid, static:false)
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
 * Missing/mismatched sidecar → not attach (do not adopt a foreign
 * velarixbot). */
export function isAttachableOurs(body, sidecar) {
  if (!isOursHealth(body) || !sidecar) return false;
  return Number(body.pid) === Number(sidecar.pid) && Number(sidecar.pid) > 0;
}

export function decideListenerAction({ health, sidecar, childPid = null }) {
  if (!health) return { action: "spawn", reason: "empty" };
  if (isAttachableOurs(health, sidecar)) return { action: "attach", reason: "sidecar-pid" };
  if (childPid != null && isSpawnedChildHealth(health, childPid)) {
    return { action: "spawn-owned", reason: "child-pid" };
  }
  if (health.app === "velarixbot") {
    return { action: "conflict", reason: health.static ? "velarixbot-not-ours" : "velarixbot-not-static" };
  }
  return { action: "skip", reason: "foreign" };
}

/** Packaged GUI: attach to ours; never fork; start the OS service when
 * every candidate is empty; refuse a second fleet on a velarixbot we
 * do not own. */
export function decidePackagedGuiAction(results) {
  const list = Array.isArray(results) ? results : [];
  for (const row of list) {
    const decided = decideListenerAction(row);
    if (decided.action === "attach") {
      return { action: "attach", port: row.port, reason: decided.reason };
    }
    if (decided.action === "conflict") {
      return { action: "conflict", port: row.port, reason: decided.reason };
    }
  }
  if (list.length === 0 || list.every((row) => decideListenerAction(row).action === "spawn")) {
    return { action: "start-service", reason: "empty" };
  }
  if (list.every((row) => decideListenerAction(row).action === "skip" || decideListenerAction(row).action === "spawn")) {
    return { action: "start-service", reason: "fallback-port" };
  }
  return { action: "conflict", reason: "unresolved" };
}

/** --harness-service host: fork only when empty; exit-0 if we already
 * own the listener (idempotent, no double fork); never adopt foreign. */
export function decideServiceHostAction(results) {
  const list = Array.isArray(results) ? results : [];
  for (const row of list) {
    const decided = decideListenerAction(row);
    if (decided.action === "attach" || decided.action === "spawn-owned") {
      return { action: "already-running", port: row.port, reason: decided.reason };
    }
    if (decided.action === "conflict") {
      return { action: "conflict", port: row.port, reason: decided.reason };
    }
    if (decided.action === "spawn") {
      return { action: "spawn", port: row.port, reason: decided.reason };
    }
  }
  return { action: "conflict", reason: "no-port" };
}

export function shouldForkHarness(decision) {
  return decision?.action === "spawn";
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
