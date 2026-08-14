// Restart policy for the forked harness server. Before this existed the
// utilityProcess exit was only observed during startup — a post-boot server
// death (e.g. one bad CLI crashing the process) left the window up while
// every bot was dead until app relaunch (rc.12 field failure). main.mjs
// respawns through this policy; the cap keeps a broken install from
// flapping forever.
export function createRestartPolicy({ maxRestarts = 3, windowMs = 60_000, now = Date.now } = {}) {
  const attempts = [];
  return {
    /** Record one restart attempt. False = give up: too many in-window. */
    shouldRestart() {
      const t = now();
      while (attempts.length && t - attempts[0] > windowMs) attempts.shift();
      if (attempts.length >= maxRestarts) return false;
      attempts.push(t);
      return true;
    },
  };
}
