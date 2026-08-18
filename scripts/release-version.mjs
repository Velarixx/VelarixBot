// Shared 0.x release-version gate for release.yml and tests.
// Accepts 0.x.x (full unsigned GitHub Release) and 0.x.x-rc.N (prerelease).
// Hard gate: refuse to tag/publish when the input ≠ package.json version.
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_VERSION_RE = /^0\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/;

export const RC_RELEASE_NOTES =
  "Internal unsigned release candidate. Download only from this private repository and follow INTERNAL_INSTALL.md to trust this specific app.";

export const FULL_RELEASE_NOTES =
  "Unsigned desktop build. Download only from this private repository and follow INTERNAL_INSTALL.md to trust this specific app.";

export function parseReleaseVersion(input) {
  const version = String(input ?? "").trim();
  if (!RELEASE_VERSION_RE.test(version)) {
    throw new Error(`Invalid 0.x version: ${version || "(empty)"}`);
  }
  return { version, prerelease: /-rc\.[0-9]+$/.test(version) };
}

export function releaseNotes(parsed) {
  return parsed.prerelease ? RC_RELEASE_NOTES : FULL_RELEASE_NOTES;
}

/** Extra flags for `gh release create`. Full 0.x.x must not include --prerelease. */
export function ghReleaseCreateExtras(parsed) {
  return parsed.prerelease ? ["--prerelease"] : [];
}

export function formatGithubOutput(parsed) {
  return `prerelease=${parsed.prerelease}\nnotes=${releaseNotes(parsed)}\n`;
}

export function repoPackageJsonPath() {
  return resolve(fileURLToPath(new URL("../package.json", import.meta.url)));
}

export function readPackageVersion(pkgPath) {
  const raw = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!version) throw new Error(`package.json has no version: ${pkgPath}`);
  return version;
}

/** Fail the release when the workflow input disagrees with the committed version. */
export function assertReleaseMatchesPackage(inputVersion, packageVersion) {
  if (String(inputVersion) !== String(packageVersion)) {
    throw new Error(
      `Release version ${inputVersion} does not match package.json version ${packageVersion}`,
    );
  }
}

function main(argv) {
  const args = argv.slice(2);
  let githubOutput = false;
  const positional = [];
  for (const arg of args) {
    if (arg === "--github-output") githubOutput = true;
    else positional.push(arg);
  }
  let parsed;
  try {
    parsed = parseReleaseVersion(positional[0]);
    assertReleaseMatchesPackage(parsed.version, readPackageVersion(repoPackageJsonPath()));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const body = formatGithubOutput(parsed);
  if (githubOutput && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, body);
    return;
  }
  process.stdout.write(body);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main(process.argv);
