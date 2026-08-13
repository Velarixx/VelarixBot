// Playwright nightly / rc eval entry.
//   node eval/run.mjs           — skip (exit 0) without secrets; else run
//   node eval/run.mjs --gate    — presence check only (writes GITHUB_OUTPUT ran=)
// Hard-fail: mechanical invariants only. Judge scores are report-only.
// Never logs or writes secret values. Temp HOME only — never ~/.velarixbot.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectSecrets, formatPresence, secretValues, skipMessage, SECRET_NAMES } from "./secrets.mjs";
import { mcpMechanicalFail } from "./mcp.mjs";
import { maxTurns } from "./turns.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");
const PORT = Number(process.env.OMB_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;

function redact(text, values) {
  let out = String(text ?? "");
  for (const value of values) {
    if (value && value.length > 4) out = out.split(value).join("[redacted]");
  }
  return out;
}

function writeGate(ran) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ran=${ran}\n`);
}

function failMechanical(mechanical, transcripts = []) {
  const missing = [];
  if (!mechanical.serverUp) missing.push("server up");
  if (!mechanical.uiReachable) missing.push("UI reachable");
  if (!mechanical.onboardingCompleted) missing.push("onboarding completed");
  const created = mechanical.botsCreated ?? [];
  if (!["Support", "Ops", "Research"].every((name) => created.includes(name))) {
    missing.push("bots created (Support / Ops / Research)");
  }
  const streams = mechanical.streamObserved ?? {};
  if (!Object.values(streams).some(Boolean)) missing.push("stream observed");
  if (mechanical.mcpSkipped === false) {
    if (!created.includes("Roster")) missing.push("Codex MCP bot created (Roster)");
    const mcpTurn = transcripts.find((t) => t.bot === "Roster");
    missing.push(...mcpMechanicalFail(mcpTurn));
  }
  return missing;
}

async function waitHealth(child, stderr) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.app === "velarixbot") return body;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr()}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr()}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function seedHome(home, found, env) {
  mkdirSync(join(home, ".velarixbot"), { recursive: true });
  const instances = {
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    gemini: { driver: "geminiAgent" },
    computer: { driver: "boxAgent" },
    grok: { driver: found.grok ? "grok" : "grokAgent" },
  };
  const cfg = { instances };
  // xAI is optional. Only write the key when it is already present — never required.
  if (found.grok) cfg.xai = { key: env[SECRET_NAMES.grok] };
  writeFileSync(join(home, ".velarixbot", "config.json"), JSON.stringify(cfg, null, 2));

  if (found.codex) {
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "auth.json"), env[SECRET_NAMES.codex], { mode: 0o600 });
  }
}

function summaryMarkdown(found, mechanical, judge, missing) {
  const rows = ["Support", "Ops", "Research"].map((name) => {
    const stream = mechanical.streamObserved?.[name] ? "yes" : "no";
    const score = judge.scores?.find((s) => s.bot === name);
    const cell = (key) => (score?.[key]?.score ?? score?.error ?? "—");
    return `| ${name} | ${stream} | ${cell("inPersona")} | ${cell("addressedRequest")} | ${cell("noFabricatedCapabilities")} |`;
  });
  return [
    "## Playwright eval",
    "",
    "### Secrets (presence only)",
    "```",
    formatPresence(found),
    "```",
    "",
    "### Mechanical",
    `- server up: ${mechanical.serverUp ? "yes" : "no"}`,
    `- UI reachable: ${mechanical.uiReachable ? "yes" : "no"}`,
    `- onboarding: ${mechanical.onboardingCompleted ? "yes" : "no"}`,
    `- bots created: ${(mechanical.botsCreated ?? []).join(", ") || "none"}`,
    `- Grok scenario: ${mechanical.grokSkipped ? "skipped (xAI not required)" : "ran (optional secret present)"}`,
    `- Codex MCP on-request: ${mechanical.mcpSkipped ? "skipped (no Codex secret)" : "ran (list_bots exactly once + Allow)"}`,
    `- Allow clicked: ${mechanical.allowClicked ? "yes" : mechanical.allowShown ? "shown, click failed" : "not shown (not a fail)"}`,
    `- hard-fail: ${missing.length ? missing.join("; ") : "none"}`,
    "",
    "### Judge (report-only — never fails the job)",
    judge.skipped ? `_skipped: ${judge.reason}_` : `_model: ${judge.model}_`,
    "",
    "| Bot | Stream | In persona | Addressed | No fabrications |",
    "|-----|--------|------------|-----------|-----------------|",
    ...rows,
    "",
  ].join("\n");
}

async function main() {
  const found = detectSecrets(process.env);
  const gate = process.argv.includes("--gate");

  if (gate) {
    writeGate(found.ready ? "true" : "false");
    console.log(found.ready ? `Eval will run.\n${formatPresence(found)}` : skipMessage());
    process.exit(0);
  }

  if (!found.ready) {
    writeGate("false");
    console.log(skipMessage());
    process.exit(0);
  }

  writeGate("true");
  const cap = maxTurns(process.env);
  console.log(`Running Playwright eval.\n${formatPresence(found)}\nTIER_B_MAX_TURNS=${cap}`);

  const values = secretValues(process.env);
  const artifactsDir = process.env.EVAL_ARTIFACTS || join(REPO, "eval-artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const home = process.env.EVAL_HOME || join(tmpdir(), `velarixbot-eval-${process.pid}`);
  mkdirSync(home, { recursive: true });
  seedHome(home, found, process.env);

  const dist = join(REPO, "dist");
  const viteEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of [...Object.values(SECRET_NAMES), "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete viteEnv[key];
  const built = await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "vite", "build"], {
      cwd: REPO,
      stdio: "inherit",
      env: viteEnv,
    });
    child.on("exit", (code) => (code === 0 ? resolve(true) : reject(new Error(`vite build exited ${code}`))));
  });
  if (!built) throw new Error("vite build failed");

  const serverEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    OMB_PORT: String(PORT),
    OMB_STATIC_DIR: dist,
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
  };
  if (found.claude) serverEnv[SECRET_NAMES.claude] = process.env[SECRET_NAMES.claude];
  // Codex secret is written to CODEX_HOME/auth.json only — never forwarded as env,
  // argv, or artifacts. ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY stay out.

  let stderr = "";
  const child = spawn(process.execPath, [join(REPO, "server", "index.ts")], {
    cwd: REPO,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += redact(String(chunk), values);
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(redact(String(chunk), values));
  });

  const mechanical = {
    serverUp: false,
    uiReachable: false,
    onboardingCompleted: false,
    botsCreated: [],
    grokSkipped: true,
    mcpSkipped: true,
    allowClicked: false,
    allowShown: false,
    streamObserved: {},
  };
  let transcripts = [];
  let screenshots = [];
  let judge = { skipped: true, reason: "eval did not reach judge" };

  try {
    await waitHealth(child, () => stderr);
    mechanical.serverUp = true;

    const { runFlow } = await import("./flow.mjs");
    const result = await runFlow({
      baseUrl: BASE,
      artifactsDir,
      includeGrok: found.grok,
      includeCodexMcp: found.codex,
      maxTurns: cap,
    });
    Object.assign(mechanical, result.mechanical, { serverUp: true });
    transcripts = result.transcripts;
    screenshots = result.screenshots;

    const { gradeTranscripts } = await import("./judge.mjs");
    judge = await gradeTranscripts(transcripts, {
      apiKey: found.grok ? process.env[SECRET_NAMES.grok] : "",
      redact: (text) => redact(text, values),
    });
  } catch (err) {
    console.error(redact(err instanceof Error ? err.stack || err.message : String(err), values));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000).unref?.();
    });
    if (!process.env.EVAL_KEEP_HOME) rmSync(home, { recursive: true, force: true });
  }

  const safeTranscripts = transcripts.map((t) => ({
    bot: t.bot,
    title: t.title,
    description: redact(t.description, values),
    prompt: redact(t.prompt, values),
    reply: redact(t.reply, values),
    streamObserved: t.streamObserved,
    allowClicked: t.allowClicked,
    state: t.state,
    tools: (t.messages ?? [])
      .filter((m) => m?.kind === "activity" && m.tool)
      .map((m) => ({ name: redact(m.tool.name, values), ok: m.tool.ok })),
  }));
  const missing = failMechanical(mechanical, transcripts);
  const report = {
    secrets: { claude: found.claude, codex: found.codex, grok: found.grok, grokOptional: true },
    mechanical,
    judge,
    fail: missing,
  };
  writeFileSync(join(artifactsDir, "scores.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(artifactsDir, "transcripts.json"), JSON.stringify(safeTranscripts, null, 2));
  const md = summaryMarkdown(found, mechanical, judge, missing);
  writeFileSync(join(artifactsDir, "summary.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  if (screenshots.length) console.log(`screenshots: ${screenshots.length} under ${join(artifactsDir, "screenshots")}`);

  if (missing.length) {
    console.error(`Mechanical invariants failed: ${missing.join("; ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
