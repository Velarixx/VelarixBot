import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerDir = join(root, "docs", "product", "dhv-71-vitest-skip-ledger");
const manifest = JSON.parse(readFileSync(join(ledgerDir, "manifest.json"), "utf8"));
const major = Number.parseInt(process.versions.node.split(".")[0], 10);

if (major < 24) {
  console.error(`FAIL: Node >=24 is required; observed ${process.version}.`);
  process.exit(1);
}

const entries = [];
const schemaErrors = [];
if (manifest.schemaVersion !== 2) {
  schemaErrors.push(`manifest schemaVersion must be 2, observed ${manifest.schemaVersion}`);
}
for (const shard of manifest.shards ?? []) {
  let rows;
  try {
    rows = JSON.parse(readFileSync(join(ledgerDir, shard.file), "utf8"));
  } catch (error) {
    schemaErrors.push(`${shard.file}: unreadable JSON (${error.message})`);
    continue;
  }
  if (!Array.isArray(rows)) {
    schemaErrors.push(`${shard.file}: root must be an array`);
    continue;
  }
  if (rows.length !== shard.count) {
    schemaErrors.push(`${shard.file}: manifest count ${shard.count}, observed ${rows.length}`);
  }
  entries.push(...rows);
}

const requiredStrings = ["file", "name", "condition", "reason", "owner", "classification"];
const allowedClasses = new Set([
  "valid_platform_na",
  "valid_capability_na",
  "missing_dependency",
  "mock_only_gap",
  "unjustified_skip",
]);
const expectedValidity = new Map([
  ["valid_platform_na", true],
  ["valid_capability_na", true],
  ["missing_dependency", false],
  ["mock_only_gap", false],
  ["unjustified_skip", false],
]);
for (const [index, entry] of entries.entries()) {
  for (const field of requiredStrings) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      schemaErrors.push(`entry ${index + 1}: ${field} must be a non-empty string`);
    }
  }
  if (typeof entry.valid !== "boolean") {
    schemaErrors.push(`entry ${index + 1}: valid must be a boolean`);
  }
  if (!allowedClasses.has(entry.classification)) {
    schemaErrors.push(`entry ${index + 1}: unknown classification ${entry.classification}`);
  } else if (typeof entry.valid === "boolean" && entry.valid !== expectedValidity.get(entry.classification)) {
    schemaErrors.push(
      `entry ${index + 1}: classification ${entry.classification} requires valid=${expectedValidity.get(entry.classification)}`,
    );
  }
  if (entry.classification === "unjustified_skip") {
    schemaErrors.push(`entry ${index + 1}: unjustified skips are never accepted`);
  }
  if (entry.valid === false) {
    if (typeof entry.remediation !== "string" || entry.remediation.trim() === "") {
      schemaErrors.push(`entry ${index + 1}: invalid row requires a non-empty remediation reference`);
    }
    if (typeof entry.remediationOwner !== "string" || entry.remediationOwner.trim() === "") {
      schemaErrors.push(`entry ${index + 1}: invalid row requires a non-empty remediationOwner`);
    }
  } else if (entry.valid === true && entry.remediation !== null) {
    schemaErrors.push(`entry ${index + 1}: valid row remediation must be null`);
  }
}

const observedClassCounts = Object.fromEntries(
  [...allowedClasses].map((classification) => [
    classification,
    entries.filter((entry) => entry.classification === classification).length,
  ]),
);
for (const classification of allowedClasses) {
  if ((manifest.classCounts?.[classification] ?? 0) !== observedClassCounts[classification]) {
    schemaErrors.push(
      `classCounts.${classification}: manifest ${manifest.classCounts?.[classification] ?? 0}, ledger ${observedClassCounts[classification]}`,
    );
  }
}
if (entries.length !== manifest.baseline?.skippedTests) {
  schemaErrors.push(`baseline skippedTests ${manifest.baseline?.skippedTests}, ledger entries ${entries.length}`);
}

if (schemaErrors.length > 0) {
  console.error("FAIL: invalid Vitest skip ledger:");
  for (const error of schemaErrors) console.error(`  - ${error}`);
  process.exit(1);
}

const commandExists = (command) => {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
    windowsHide: true,
  });
  return probe.status === 0;
};

const hasGemini = commandExists("gemini");
const applies = (entry) => {
  if (entry.classification === "valid_platform_na") return process.platform === "win32";
  if (entry.classification === "valid_capability_na") return true;
  if (entry.classification === "missing_dependency") return !hasGemini;
  return true;
};

const keyOf = (file, name) => `${file}\u0000${name}`;
const expected = new Map();
for (const entry of entries.filter(applies)) {
  const key = keyOf(entry.file, entry.name);
  expected.set(key, (expected.get(key) ?? 0) + 1);
}

const args = process.argv.slice(2);
const reportIndex = args.indexOf("--report");
let reportPath = reportIndex >= 0 ? args[reportIndex + 1] : null;
if (reportIndex >= 0 && !reportPath) {
  console.error("FAIL: --report requires a Vitest JSON report path.");
  process.exit(1);
}

let vitestExit = null;
let scratch = null;
if (!reportPath) {
  scratch = mkdtempSync(join(tmpdir(), "velarix-vitest-skip-inventory-"));
  reportPath = join(scratch, "vitest.json");
  const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
  const run = spawnSync(process.execPath, [vitest, "run", "--reporter=json", `--outputFile=${reportPath}`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  vitestExit = run.status;
  if (run.error) console.error(`Vitest launch error: ${run.error.message}`);
  if (run.stdout?.trim()) console.log(run.stdout.trim());
  if (run.stderr?.trim()) console.error(run.stderr.trim());
}

let report;
try {
  report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
} catch (error) {
  console.error(`FAIL: cannot read Vitest JSON report ${reportPath}: ${error.message}`);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const knownFiles = [...new Set(entries.map((entry) => entry.file))].sort((a, b) => b.length - a.length);
const normalizeFile = (name) => {
  const slash = String(name).replaceAll("\\", "/");
  for (const file of knownFiles) {
    if (slash === file || slash.endsWith(`/${file}`)) return file;
  }
  return (isAbsolute(name) ? relative(root, name) : name).replaceAll("\\", "/");
};

const actual = new Map();
for (const suite of report.testResults ?? []) {
  const file = normalizeFile(suite.name);
  for (const assertion of suite.assertionResults ?? []) {
    if (assertion.status !== "skipped") continue;
    const key = keyOf(file, assertion.fullName);
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
}
if (args.includes("--negative-control")) {
  actual.set(keyOf("negative-control.test.ts", "DHV-71 synthetic unreasoned skip"), 1);
}

const display = (key) => key.replace("\u0000", " :: ");
const newOrUnreasoned = [];
const missingExpected = [];
for (const [key, count] of actual) {
  const surplus = count - (expected.get(key) ?? 0);
  for (let i = 0; i < surplus; i += 1) newOrUnreasoned.push(display(key));
}
for (const [key, count] of expected) {
  const deficit = count - (actual.get(key) ?? 0);
  for (let i = 0; i < deficit; i += 1) missingExpected.push(display(key));
}

const actualCount = [...actual.values()].reduce((sum, count) => sum + count, 0);
const expectedCount = [...expected.values()].reduce((sum, count) => sum + count, 0);
const reportCount = report.numPendingTests;
if (typeof reportCount === "number" && reportCount !== actualCount) {
  schemaErrors.push(`report numPendingTests ${reportCount}, enumerated skipped assertions ${actualCount}`);
}

console.log(
  `Vitest skip inventory: runtime=${process.version} platform=${process.platform} gemini=${hasGemini ? "present" : "absent"} expected=${expectedCount} observed=${actualCount}`,
);
console.log(
  `Classes: platform=${observedClassCounts.valid_platform_na}, capability=${observedClassCounts.valid_capability_na}, missing_dependency=${observedClassCounts.missing_dependency}, mock_only_gap=${observedClassCounts.mock_only_gap}, unjustified=${observedClassCounts.unjustified_skip}`,
);

let failed = false;
if (schemaErrors.length > 0) {
  failed = true;
  for (const error of schemaErrors) console.error(`FAIL: ${error}`);
}
if (newOrUnreasoned.length > 0) {
  failed = true;
  console.error("FAIL: new or unreasoned skips:");
  for (const item of newOrUnreasoned) console.error(`  + ${item}`);
}
if (missingExpected.length > 0) {
  failed = true;
  console.error("FAIL: ledgered skips no longer observed (remove or update the stale ledger rows with review):");
  for (const item of missingExpected) console.error(`  - ${item}`);
}
if (vitestExit !== null && vitestExit !== 0) {
  failed = true;
  console.error(`FAIL: Vitest exited ${vitestExit}; assertion/suite failures block the fresh gate even when skip inventory matches.`);
}

if (scratch) rmSync(scratch, { recursive: true, force: true });
if (failed) process.exit(1);
console.log(reportIndex >= 0 ? "PASS: report skip inventory exactly matches its reasoned ledger." : "PASS: Vitest and skip inventory gate passed.");
