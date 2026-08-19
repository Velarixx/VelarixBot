import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const ci = read(".github/workflows/ci.yml");
const release = read(".github/workflows/release.yml");
const policy = read("docs/product/exact-sha-release-gate.md");
const playwright = read("playwright.release.config.ts");
const template = read(".github/release-acceptance-template.md");
const pkg = JSON.parse(read("package.json"));
const failures = [];
const nodeMajor = Number(process.versions.node.split(".")[0]);

function requireText(source, fragment, location) {
  if (!source.includes(fragment)) failures.push(location + ": missing " + JSON.stringify(fragment));
}

function rejectText(source, fragment, location) {
  if (source.includes(fragment)) failures.push(location + ": forbidden " + JSON.stringify(fragment));
}

if (nodeMajor < 24) failures.push("runtime: Node 24 or newer is required; observed " + process.version);
if (pkg.engines?.node !== ">=24") failures.push("package.json: engines.node must remain >=24");
if (pkg.packageManager !== "pnpm@10.33.0") failures.push("package.json: packageManager must remain pinned");
if (pkg.scripts?.["test:e2e"] !== "vite build && playwright test --config=playwright.release.config.ts") {
  failures.push("package.json: test:e2e must use the isolated release Playwright config");
}
for (const spec of ["fake-engine-smoke.spec.ts", "session-boundary.spec.ts"]) {
  requireText(playwright, spec, "playwright.release.config.ts");
}
requireText(playwright, 'testDir: "./e2e"', "playwright.release.config.ts");

for (const script of [
  "build",
  "test",
  "test:e2e",
  "typecheck",
  "typecheck:smoke",
  "verify:inventories",
  "verify:lint-format",
  "verify:release-gate",
]) {
  if (!pkg.scripts?.[script]) failures.push("package.json: missing script " + script);
}

for (const fragment of [
  "pull_request:",
  "push:",
  "branches: [main]",
  "workflow_dispatch:",
  "name: exact-sha-release-gate",
  "node-version: 24",
  "corepack pnpm install --frozen-lockfile",
  "corepack pnpm verify:lint-format",
  "node scripts/secret-scan.mjs",
  "corepack pnpm audit --audit-level=high",
  "corepack pnpm verify:inventories",
  "corepack pnpm typecheck",
  "corepack pnpm typecheck:smoke",
  "corepack pnpm test",
  "corepack pnpm build",
  "corepack pnpm test:e2e",
  "test \"$actual\" = \"$EXPECTED_SHA\"",
]) {
  requireText(ci, fragment, ".github/workflows/ci.yml");
}
rejectText(ci, "paths-ignore:", ".github/workflows/ci.yml");
rejectText(ci, "pull_request.draft", ".github/workflows/ci.yml");
if ((ci.match(/runs-on:/g) ?? []).length !== 1) {
  failures.push(".github/workflows/ci.yml: gate must remain one required job");
}

for (const fragment of [
  "accepted_sha:",
  "acceptance_record_url:",
  "environment: exact-sha-release",
  "test \"$ACCEPTED_SHA\" = \"$GITHUB_SHA\"",
  "sha=\"${{ github.sha }}\"",
  "exact-sha-release-gate",
  "checks: read",
]) {
  requireText(release, fragment, ".github/workflows/release.yml");
}

for (const fragment of [
  "Any failure blocks",
  "Absent CI blocks",
  "Unsupported Node blocks",
  "Unjustified skips block",
  "new SHA and a fresh gate",
  "Self-approval is prohibited",
  "origin/main",
  "exact-sha-release-gate",
]) {
  requireText(policy, fragment, "docs/product/exact-sha-release-gate.md");
}

for (const fragment of [
  "Candidate SHA",
  "Parent SHA",
  "Developer evidence",
  "Independent reviewer",
  "QA/Test Lead",
  "Exact commands and counts",
  "Justified skips",
  "Runtime and OS",
  "CI URLs and status",
  "Residual risks",
  "Push result",
  "origin/main equality",
  "Required GitHub checks",
]) {
  requireText(template, fragment, ".github/release-acceptance-template.md");
}

if (failures.length > 0) {
  console.error("Exact-SHA release-gate validation failed:");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}

console.log("Exact-SHA release-gate validation passed on " + process.version + ".");
console.log("Required check context: exact-sha-release-gate");
