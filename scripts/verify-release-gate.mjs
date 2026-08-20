import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

function requireText(failures, source, fragment, location) {
  if (!source.includes(fragment)) {
    failures.push(location + ": missing " + JSON.stringify(fragment));
  }
}

function rejectText(failures, source, fragment, location) {
  if (source.includes(fragment)) {
    failures.push(location + ": forbidden " + JSON.stringify(fragment));
  }
}

function validateGate(bundle, runtimeMajor) {
  const { ci, release, policy, playwright, template, pkg } = bundle;
  const failures = [];

  if (runtimeMajor < 24) {
    failures.push("runtime: Node 24 or newer is required; observed major " + runtimeMajor);
  }
  if (pkg.engines?.node !== ">=24") {
    failures.push("package.json: engines.node must remain >=24");
  }
  if (pkg.packageManager !== "pnpm@10.33.0") {
    failures.push("package.json: packageManager must remain pinned to pnpm@10.33.0");
  }

  const exactScripts = {
    "test:e2e": "vite build && playwright test --config=playwright.release.config.ts",
    "verify:inventories":
      "vitest run server/import-hygiene.test.ts server/saas-route-surface.test.ts server/secret-scan.test.ts",
    "verify:lint-format": "node scripts/verify-lint-format.mjs",
    "verify:release-gate": "node scripts/verify-release-gate.mjs",
  };
  for (const [name, command] of Object.entries(exactScripts)) {
    if (pkg.scripts?.[name] !== command) {
      failures.push("package.json: script " + name + " must be " + JSON.stringify(command));
    }
  }
  for (const script of ["build", "test", "typecheck", "typecheck:smoke"]) {
    if (!pkg.scripts?.[script]) {
      failures.push("package.json: missing repository command " + script);
    }
  }

  requireText(failures, playwright, 'testDir: "./e2e"', "playwright.release.config.ts");
  requireText(failures, playwright, '"fake-engine-smoke.spec.ts"', "playwright.release.config.ts");
  requireText(failures, playwright, '"session-boundary.spec.ts"', "playwright.release.config.ts");
  requireText(failures, playwright, "workers: 1", "playwright.release.config.ts");
  requireText(failures, playwright, "fullyParallel: false", "playwright.release.config.ts");

  for (const fragment of [
    "pull_request:",
    "branches: [main]",
    "types: [opened, synchronize, reopened, ready_for_review]",
    "push:",
    "workflow_dispatch:",
    "name: exact-sha-release-gate",
    'CI: "true"',
    "EXPECTED_SHA:",
    "ref: " + "$" + "{{ env.EXPECTED_SHA }}",
    "persist-credentials: false",
    '[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]',
    'test "$actual" = "$EXPECTED_SHA"',
    "node-version: 24",
    "corepack pnpm install --frozen-lockfile",
    "corepack pnpm verify:release-gate",
    "corepack pnpm verify:lint-format",
    "node scripts/secret-scan.mjs",
    "corepack pnpm audit --audit-level=high",
    "corepack pnpm verify:inventories",
    "corepack pnpm typecheck",
    "corepack pnpm typecheck:smoke",
    "corepack pnpm test",
    "corepack pnpm build",
    "corepack pnpm test:e2e",
  ]) {
    requireText(failures, ci, fragment, ".github/workflows/ci.yml");
  }
  for (const fragment of [
    "paths-ignore:",
    "pull_request.draft",
    "continue-on-error:",
    "|| true",
    "--no-frozen-lockfile",
    "--ignore-scripts",
  ]) {
    rejectText(failures, ci, fragment, ".github/workflows/ci.yml");
  }

  const jobsMarker = "\njobs:\n";
  const jobs = ci.includes(jobsMarker) ? ci.split(jobsMarker)[1] : "";
  const jobKeys = [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map((match) => match[1]);
  if (jobKeys.length !== 1 || jobKeys[0] !== "release-gate") {
    failures.push(".github/workflows/ci.yml: exactly one job key named release-gate is required");
  }

  for (const fragment of [
    "accepted_sha:",
    "acceptance_record_url:",
    "environment: exact-sha-release",
    "ref: " + "$" + "{{ inputs.accepted_sha }}",
    "persist-credentials: false",
    'test "$GITHUB_REF" = "refs/heads/main"',
    'test "$ACCEPTED_SHA" = "$GITHUB_SHA"',
    'test "$(git rev-parse HEAD)" = "$ACCEPTED_SHA"',
    ".head_sha == \\\"$ACCEPTED_SHA\\\"",
    '.status == \\"completed\\"',
    '.conclusion == \\"success\\"',
    '.app.slug == \\"github-actions\\"',
    "exact-sha-release-gate",
    "checks: read",
  ]) {
    requireText(failures, release, fragment, ".github/workflows/release.yml");
  }
  for (const fragment of ["continue-on-error:", "|| true", "bypass"]) {
    rejectText(failures, release, fragment, ".github/workflows/release.yml");
  }

  for (const fragment of [
    "Any failure blocks",
    "Absent CI blocks",
    "Unsupported Node blocks",
    "Unjustified skips block",
    "new SHA and a fresh gate",
    "Self-approval is prohibited",
    "Evidence and approvals from a previous SHA do not transfer",
    "origin/main",
    "exact-sha-release-gate",
    "dismiss stale approvals",
    "Block force pushes and branch deletion",
    "do not add bypass actors or bypass labels",
    "Apply the rule to administrators",
    "independent\n   required reviewer",
    "cannot validate Paperclip roles",
  ]) {
    requireText(failures, policy, fragment, "docs/product/exact-sha-release-gate.md");
  }
  rejectText(failures, policy, "may bypass", "docs/product/exact-sha-release-gate.md");

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
    "Workflow head SHA",
    "Required GitHub checks",
    "Residual risks",
    "Push result",
    "origin/main equality",
    "SHA changed after approval",
  ]) {
    requireText(failures, template, fragment, ".github/release-acceptance-template.md");
  }

  return failures;
}

const bundle = {
  ci: read(".github/workflows/ci.yml"),
  release: read(".github/workflows/release.yml"),
  policy: read("docs/product/exact-sha-release-gate.md"),
  playwright: read("playwright.release.config.ts"),
  template: read(".github/release-acceptance-template.md"),
  pkg: JSON.parse(read("package.json")),
};
const runtimeMajor = Number(process.versions.node.split(".")[0]);
const failures = validateGate(bundle, runtimeMajor);

if (failures.length > 0) {
  console.error("Exact-SHA release-gate validation failed:");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}

const mutationTests = [
  {
    name: "unsupported runtime",
    expected: "runtime:",
    run: () => validateGate(bundle, 22),
  },
  {
    name: "unstable required context",
    expected: 'missing "name: exact-sha-release-gate"',
    run: () =>
      validateGate(
        { ...bundle, ci: bundle.ci.replace("name: exact-sha-release-gate", "name: renamed-gate") },
        runtimeMajor,
      ),
  },
  {
    name: "wrong candidate checkout",
    expected: "missing " + JSON.stringify("ref: " + "$" + "{{ env.EXPECTED_SHA }}"),
    run: () =>
      validateGate(
        {
          ...bundle,
          ci: bundle.ci.replace(
            "ref: " + "$" + "{{ env.EXPECTED_SHA }}",
            "ref: " + "$" + "{{ github.sha }}",
          ),
        },
        runtimeMajor,
      ),
  },
  {
    name: "non-frozen install",
    expected: 'missing "corepack pnpm install --frozen-lockfile"',
    run: () =>
      validateGate(
        {
          ...bundle,
          ci: bundle.ci.replace(
            "corepack pnpm install --frozen-lockfile",
            "corepack pnpm install --no-frozen-lockfile",
          ),
        },
        runtimeMajor,
      ),
  },
  {
    name: "soft-failed CI step",
    expected: 'forbidden "continue-on-error:"',
    run: () => validateGate({ ...bundle, ci: bundle.ci + "\ncontinue-on-error: true\n" }, runtimeMajor),
  },
  {
    name: "missing deterministic browser spec",
    expected: 'missing "\\"session-boundary.spec.ts\\""',
    run: () =>
      validateGate(
        {
          ...bundle,
          playwright: bundle.playwright.replace('    "session-boundary.spec.ts",\n', ""),
        },
        runtimeMajor,
      ),
  },
  {
    name: "stale required check accepted",
    expected: 'missing ".head_sha',
    run: () =>
      validateGate(
        {
          ...bundle,
          release: bundle.release.replace('.head_sha == \\"$ACCEPTED_SHA\\" and ', ""),
        },
        runtimeMajor,
      ),
  },
  {
    name: "untrusted check producer accepted",
    expected: 'missing ".app.slug',
    run: () =>
      validateGate(
        {
          ...bundle,
          release: bundle.release.replace(' and .app.slug == \\"github-actions\\"', ""),
        },
        runtimeMajor,
      ),
  },
  {
    name: "QA identity omitted",
    expected: 'missing "QA/Test Lead"',
    run: () =>
      validateGate(
        { ...bundle, template: bundle.template.replaceAll("QA/Test Lead", "Release approver") },
        runtimeMajor,
      ),
  },
];

const selfTestFailures = [];
for (const test of mutationTests) {
  const observed = test.run();
  if (!observed.some((failure) => failure.includes(test.expected))) {
    selfTestFailures.push(test.name + ": validator did not reject with " + JSON.stringify(test.expected));
  }
}
if (selfTestFailures.length > 0) {
  console.error("Exact-SHA release-gate self-tests failed:");
  for (const failure of selfTestFailures) console.error("- " + failure);
  process.exit(1);
}

console.log("Exact-SHA release-gate validation passed on " + process.version + ".");
console.log("Required check context: exact-sha-release-gate");
console.log("Fail-closed mutation self-tests: " + mutationTests.length + " passed.");
