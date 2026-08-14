// P0.6 secret-scan gate: fail CI if a credential-shaped string is committed.
// Plain node, no dependency — patterns are the high-confidence token shapes
// of the providers this repo actually touches (matching the redaction lists
// in server/approvals.ts / server/handoff.ts) plus the classic cloud/key
// formats. Findings report file, line, and pattern name ONLY — never the
// matched value, so the scan output can't itself leak.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Deliberately-fake short secrets in tests ("sk-live-supersecret",
// "xai-abc123restofkey") stay below these length floors; real issued tokens
// don't. Keep new fixtures short or constructed at runtime.
export const SECRET_PATTERNS = Object.freeze([
  { name: "github token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { name: "github fine-grained pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { name: "aws access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google api key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: "slack token", re: /\bxox[baprs]-[0-9A-Za-z][0-9A-Za-z-]{10,}/g },
  { name: "stripe live key", re: /\b[sr]k_live_[0-9a-zA-Z]{20,}/g },
  { name: "openai api key", re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g },
  { name: "anthropic api key", re: /\bsk-ant-[A-Za-z0-9-]{20,}/g },
  { name: "xai api key", re: /\bxai-[A-Za-z0-9]{32,}/g },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g },
]);

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Findings carry {path, line, name} and never the matched value. */
export function scanText(text, path) {
  const findings = [];
  for (const { name, re } of SECRET_PATTERNS) {
    for (const match of text.matchAll(re)) {
      findings.push({ path, line: lineOf(text, match.index), name });
    }
  }
  return findings;
}

export function isBinary(buffer) {
  const probe = buffer.subarray(0, 8192);
  return probe.includes(0);
}

/** Scan files (paths relative to root). Binary and missing files are skipped. */
export function scanFiles(paths, root = REPO_ROOT) {
  const findings = [];
  for (const path of paths) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    const buffer = readFileSync(absolute);
    if (isBinary(buffer)) continue;
    findings.push(...scanText(buffer.toString("utf8"), path));
  }
  return findings;
}

/** Git-tracked files only — node_modules and build output never count. */
export function collectTrackedFiles(root = REPO_ROOT) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr || result.error?.message || `status ${result.status}`}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const files = collectTrackedFiles();
  const findings = scanFiles(files);
  if (findings.length > 0) {
    for (const f of findings) {
      process.stderr.write(`${f.path}:${f.line} matches "${f.name}" — remove it and rotate the credential\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`secret scan: ${files.length} tracked files clean\n`);
}
