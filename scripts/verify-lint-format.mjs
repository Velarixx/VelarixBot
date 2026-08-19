import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ".github/pull_request_template.md",
  ".github/release-acceptance-template.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "docs/product/dhv-54-pre-edit-release-gate-audit.md",
  "docs/product/dhv-54-release-gate-evidence.md",
  "docs/product/exact-sha-release-gate.md",
  "package.json",
  "playwright.release.config.ts",
  "scripts/verify-lint-format.mjs",
  "scripts/verify-release-gate.mjs",
];

const failures = [];
for (const relativePath of files) {
  const text = readFileSync(join(root, relativePath), "utf8");
  if (!text.endsWith("\n")) failures.push(relativePath + ": final newline is required");
  text.split("\n").forEach((line, index) => {
    if (/[ \t]+$/.test(line)) failures.push(relativePath + ":" + (index + 1) + ": trailing whitespace");
    if (line.includes("\t")) failures.push(relativePath + ":" + (index + 1) + ": tab character");
  });
}

try {
  JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
} catch (error) {
  failures.push("package.json: invalid JSON: " + error.message);
}

if (failures.length > 0) {
  console.error("Release-gate lint/format verification failed:");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}

console.log("Release-gate lint/format verification passed for " + files.length + " files.");
