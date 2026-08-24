// Post-quit updater helper. Copied to a temp dir and launched with
// ELECTRON_RUN_AS_NODE so it outlives the GUI and does not run from the
// bundle being replaced. Argv only: node/electron helper.mjs <plan.json>
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyUpdate } from "./update-apply.mjs";

function runArgv(command, args = [], { detached = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: detached ? "ignore" : ["ignore", "pipe", "pipe"],
      detached,
    });
    if (detached) {
      child.unref();
      resolve({ status: 0, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

export async function runHelper(planPath, deps = {}) {
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  return applyUpdate(plan, {
    runArgv: deps.runArgv ?? runArgv,
    listDir: deps.listDir ?? ((dir) => readdirSync(dir)),
    writeResult: async (result) => {
      if (!plan.resultPath) return;
      writeFileSync(plan.resultPath, JSON.stringify(result));
    },
    wait: deps.wait,
  });
}

const entry = fileURLToPath(import.meta.url);
const invoked = process.argv[1] && resolve(process.argv[1]) === entry;
if (invoked && process.argv[2]) {
  runHelper(process.argv[2]).then((result) => {
    process.exit(result.ok ? 0 : 1);
  });
}
