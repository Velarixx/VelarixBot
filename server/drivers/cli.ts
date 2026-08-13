// Windows CLI helpers.
//
// CLIs installed via npm/yarn/pnpm on Windows ship as .cmd batch shims
// (e.g. `codex.cmd` in %APPDATA%\npm). child_process cannot execute .cmd
// files directly — spawn/execFile fail with ENOENT/EINVAL unless the
// command runs through cmd.exe, and going through cmd.exe re-opens argv to
// its quoting and %VAR% expansion rules (the CVE-2024-27980 class — model
// names, personas, and MCP-config JSON all travel on argv here). Instead
// we resolve the shim to the real JS entry and run it with
// process.execPath — no shell at all. Native installers (the claude
// installer → claude.exe) resolve to their .exe. A shim we cannot unwrap
// is NEVER routed through cmd.exe: probes go through the pwsh wrapper
// (args in a JSON file), and turn spawns fail with a clear error instead.
//
// Blocking notes: resolveCli shells out to `where` synchronously, at most
// once per CLI per minute (cached); everything else spawns async children.
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const IS_WIN = process.platform === "win32";
const SHIM_RE = /\.(cmd|bat)$/i;
// Test fakes and JS CLIs. Shebang execution is POSIX-only — Windows cannot
// spawn a .ts file — so these always run under process.execPath.
const SCRIPT_RE = /\.[cm]?[jt]s$/i;
// cmd.exe metacharacters that survive quoting (`%VAR%` expands even inside
// double quotes). Only consulted on the last-resort .cmd path.
const CMD_META = /[&|<>^%!]/;

// `where` results don't change often; cache per CLI so per-turn spawns
// don't pay a fresh `where` process each time.
const whereCache = new Map<string, { path: string; at: number }>();
const WHERE_TTL = 60_000;

/** Windows options for short-lived harness helpers (`where`, `taskkill`,
 * `cliExec`, the no-pwsh CLI fallback). `windowsHide` maps to
 * CREATE_NO_WINDOW — the child itself must not flash a console. `detached`
 * is stripped: on Windows it is DETACHED_PROCESS and the child gets no
 * console its own descendants can inherit. */
function windowsSpawnOptions(opts: SpawnOptions): SpawnOptions {
  const { detached: _detached, ...rest } = opts;
  return { ...rest, windowsHide: true };
}

/** Windows options for the long-lived CLI tree (pwsh wrapper → Codex/Claude
 * → rust app-server → MCP / command-safety pwsh). CREATE_NO_WINDOW on this
 * root is a regression: the wrapper stays hidden, but every console-subsystem
 * grandchild (codex.exe, node MCP, powershell) allocates its own visible
 * console for the whole turn. `-WindowStyle Hidden` gives the tree one
 * hidden console to inherit instead. Do not attach to, or hide, the user's
 * own terminal — this is a new hidden console, not AttachConsole. */
function windowsCliTreeSpawnOptions(opts: SpawnOptions): SpawnOptions {
  const { detached: _detached, windowsHide: _hide, ...rest } = opts;
  return { ...rest, windowsHide: false };
}

function whereAll(name: string): string[] {
  try {
    const out = spawnSync("where", [name], { encoding: "utf8", timeout: 2000, windowsHide: true });
    if (out.status !== 0 || !out.stdout) return [];
    return out.stdout
      .split(/\r?\n/)
      .map((c) => c.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve a CLI name to a path that can actually be spawned. */
export function resolveCli(cli: string): string {
  if (!IS_WIN) return cli;
  const hit = whereCache.get(cli);
  if (hit && Date.now() - hit.at < WHERE_TTL) return hit.path;
  // first spawnable hit in PATH order — PATH shadowing is intentional, so a
  // shim that shadows a stale .exe must win
  const candidates = whereAll(cli);
  const resolved = candidates.find((c) => /\.exe$/i.test(c) || SHIM_RE.test(c)) ?? cli;
  whereCache.set(cli, { path: resolved, at: Date.now() });
  return resolved;
}

// npm/pnpm/yarn .cmd shims are thin wrappers that exec node on a JS entry.
// Two formats exist in the wild:
//   npm cmd-shim (current):  SET "dp0=%~dp0"  →  "%dp0%\...\codex.js" %*
//   yarn / older cmd-shim:   "%~dp0\...\codex.js" %*   (no trailing %)
// Extract that entry so we can spawn process.execPath directly and skip
// cmd.exe entirely.
function shimScriptTarget(shim: string): string | null {
  try {
    const text = readFileSync(shim, "utf8");
    const m = text.match(/"([^"]+\.(?:[cm]?js))"/);
    if (!m) return null;
    const raw = m[1].replace(/%(?:~dp0|dp0%)\\?/gi, dirname(shim) + "\\");
    if (raw.includes("%")) return null; // unknown var token — give up
    return isAbsolute(raw) ? raw : resolve(dirname(shim), raw);
  } catch {
    return null;
  }
}

/**
 * How to spawn a CLI on this platform:
 * - `.ts` / `.js` scripts (test fakes): this process's node. Shebang
 *   execution is POSIX-only; Windows cannot exec a `.ts` file.
 * - POSIX binaries: the raw name (resolved via PATH by the shell-less spawn).
 * - Windows: the resolved .exe, or — for .cmd shims — node running the
 *   shim's real JS entry, which needs no cmd.exe at all.
 * Falls back to the raw name when nothing better can be resolved.
 */
export function resolveCliCommand(
  cli: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  if (SCRIPT_RE.test(cli)) {
    return {
      command: process.execPath,
      args: [isAbsolute(cli) ? cli : resolve(cli)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  if (!IS_WIN) return { command: cli, args: [] };
  const resolved = resolveCli(cli);
  if (SHIM_RE.test(resolved)) {
    const script = shimScriptTarget(resolved);
    if (script) {
      return {
        command: process.execPath,
        args: [script],
        // packaged: process.execPath is the Electron binary; run as plain node
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
  }
  return { command: resolved, args: [] };
}

/** execFile equivalent that also works for .cmd shims on Windows.
 * Inherits process.env unless opts.env is given (execFile's own rule). */
export function cliExec(
  cli: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { command, args: prefix, env: runEnv } = resolveCliCommand(cli);
  return new Promise((resolvePromise) => {
    const execOpts = {
      timeout: opts.timeout,
      env: { ...(opts.env ?? process.env), ...runEnv },
      windowsHide: true,
    };
    const cb = (err: Error | null, stdout: string, stderr: string) =>
      resolvePromise({ ok: !err, stdout, stderr: stderr ?? "" });
    if (IS_WIN && SHIM_RE.test(command)) {
      // a shim we couldn't unwrap. Never cmd.exe: pwsh re-enters cmd for a
      // .cmd target, so refuse anything carrying cmd metacharacters, and
      // refuse entirely when pwsh is missing — a clear error beats an
      // injectable one.
      const pwsh = resolvePwsh();
      if (!pwsh) {
        return cb(new Error("no pwsh"), "", `cannot safely run ${command} without PowerShell 7 — install pwsh or reinstall the CLI natively`);
      }
      if ([...prefix, ...args].some((a) => CMD_META.test(a))) {
        return cb(new Error("unsafe args"), "", `refusing to pass cmd.exe metacharacters to the ${command} shim`);
      }
      return execViaPwsh(pwsh, command, [...prefix, ...args], execOpts, cb);
    }
    execFile(command, [...prefix, ...args], execOpts, cb);
  });
}

/** `cli --version` probe; null when the CLI is missing or errors. */
export function cliVersion(
  cli: string,
  timeoutMs = 8000,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  return cliExec(cli, ["--version"], { timeout: timeoutMs, env }).then((r) =>
    r.ok && r.stdout.trim() ? r.stdout.trim() : null,
  );
}

/**
 * Kill a spawned CLI and its whole process tree (child MCP servers, the
 * codex app-server worker, etc.). POSIX uses the process group
 * (children are spawned detached); Windows uses taskkill /T /F because
 * process.kill(-pid) throws ESRCH and plain kill() leaves orphans.
 * Fire-and-forget — never blocks the event loop on taskkill.
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (IS_WIN) {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {});
      killer.unref();
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// PowerShell wrapper that runs a CLI with a hidden console. windowsHide on
// the direct spawn would give the CLI NO console — then every console-app
// it spawns (cmd.exe for device-id probes, MCP servers like cua-driver.exe)
// would create its own VISIBLE console window. A hidden console instead is
// inherited by the whole subtree, so nothing ever flashes. Args travel in a
// JSON file, so there is no cmd/PowerShell quoting hazard. Both console
// encodings are forced to UTF-8 — the default OEM codepage would mojibake
// any non-ASCII in the CLI's stream-json output.
const PS_HIDDEN_WRAPPER = `param([string]$Cli, [string]$ArgsFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ArgList = @(Get-Content -Raw -LiteralPath $ArgsFile | ConvertFrom-Json)
& $Cli @ArgList
exit $LASTEXITCODE
`;

// PowerShell 5.1 (built into Windows) mangles native args that contain
// embedded quotes — fatal for --mcp-config JSON. PowerShell 7 (pwsh)
// passes argv correctly, so prefer it and fall back to a plain
// windowsHide spawn (direct child hidden; grandchildren may flash).
let pwshCache: { path: string | null; at: number } | null = null;
function resolvePwsh(): string | null {
  if (pwshCache && (pwshCache.path !== null || Date.now() - pwshCache.at < WHERE_TTL)) {
    return pwshCache.path;
  }
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    ...(process.env.ProgramW6432 ? [join(process.env.ProgramW6432, "PowerShell", "7", "pwsh.exe")] : []),
    // winget --scope user / MSIX / anything else: trust PATH
    ...whereAll("pwsh").filter((c) => /\.exe$/i.test(c)),
  ];
  const path = candidates.find((c) => existsSync(c)) ?? null;
  pwshCache = { path, at: Date.now() };
  return path;
}

function pwshWrapperArgs(cliCommand: string, cliArgs: string[]): { args: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "velarix-spawn-"));
  const argsFile = join(dir, "args.json");
  const wrapper = join(dir, "wrap.ps1");
  writeFileSync(argsFile, JSON.stringify(cliArgs));
  writeFileSync(wrapper, PS_HIDDEN_WRAPPER);
  return {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      wrapper,
      "-Cli",
      cliCommand,
      "-ArgsFile",
      argsFile,
    ],
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

function execViaPwsh(
  pwsh: string,
  command: string,
  args: string[],
  execOpts: { timeout?: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
): void {
  const { args: psArgs, cleanup } = pwshWrapperArgs(command, args);
  execFile(pwsh, psArgs, execOpts, (err, stdout, stderr) => {
    cleanup();
    cb(err, stdout, stderr);
  });
}

/**
 * Spawn a CLI so that no console window ever appears on Windows — including
 * for anything the CLI itself spawns. POSIX: plain spawn (no-op).
 * Callers pass stdio pipes (["pipe","pipe","pipe"]) and get a child with
 * live stdout/stderr streams.
 *
 * When resolveCliCommand already returns process.execPath (`.ts` fakes,
 * unwrapped `.cmd` JS entries), spawn that node directly with windowsHide.
 * Do not wrap those in the pwsh CLI tree — wrap.ps1 exits 0 without
 * running the script.
 *
 * Throws (never EINVAL-ambushes) when the target is a .cmd shim that could
 * not be unwrapped and pwsh is unavailable — spawning a .cmd without a
 * shell is a synchronous EINVAL on current Node, and spawning it WITH a
 * shell is an injection hazard. Callers already route sendTurn rejections
 * into a visible error, which is the honest failure mode here.
 */
export function spawnCliHidden(
  cli: string,
  args: string[],
  opts: SpawnOptions & { env?: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  const { command, args: prefix, env: runEnv } = resolveCliCommand(cli);
  if (!IS_WIN) {
    return spawn(command, [...prefix, ...args], opts) as ChildProcessWithoutNullStreams;
  }
  // `detached` is a POSIX-only need here (killProcessTree uses the process
  // group). On Windows it maps to DETACHED_PROCESS — the child gets NO
  // console, and pwsh then exits 0 immediately without running the script
  // or writing a byte, which surfaces as "cli exited 0 before result".
  // Windows reaps the tree with taskkill /T /F, so drop the flag.
  const helperOpts = windowsSpawnOptions(opts);
  const env = { ...(opts.env ?? process.env), ...runEnv };
  // Test fakes and unwrapped JS shims already resolve to this process's
  // node. The pwsh CLI-tree wrapper exists so native .exe children inherit
  // one hidden console — wrapping node + a .ts fake makes wrap.ps1 exit 0
  // without running the script (`grokAgent exited 0 before the prompt
  // result`). Spawn node directly with CREATE_NO_WINDOW instead.
  if (spawnDirectNode(command)) {
    return spawn(command, [...prefix, ...args], { ...helperOpts, env }) as ChildProcessWithoutNullStreams;
  }
  const pwsh = resolvePwsh();
  if (!pwsh) {
    if (SHIM_RE.test(command)) {
      throw new Error(
        `cannot run ${command}: it is a batch shim and PowerShell 7 is not installed. ` +
          `Install pwsh (winget install Microsoft.PowerShell) or reinstall the CLI natively.`,
      );
    }
    // no pwsh: hide the direct child (CREATE_NO_WINDOW). Grandchildren may
    // flash their own consoles — acceptable degradation without a wrapper.
    return spawn(command, [...prefix, ...args], { ...helperOpts, env }) as ChildProcessWithoutNullStreams;
  }
  // pwsh passes argv to native .exe/.js targets verbatim, but a .cmd target
  // re-enters cmd.exe where %VAR% expands even inside quotes — refuse to
  // send metacharacters down that path rather than risk injection
  if (SHIM_RE.test(command) && [...prefix, ...args].some((a) => CMD_META.test(a))) {
    throw new Error(
      `refusing to pass cmd.exe metacharacters to the ${command} shim — reinstall the CLI natively or via an installer that ships an .exe`,
    );
  }
  // Do not set windowsHide/CREATE_NO_WINDOW on this spawn. The wrapper is
  // hidden via -WindowStyle Hidden so Codex, its rust app-server, MCP
  // proxies, and command-safety pwsh inherit one hidden console instead of
  // each opening a visible cmd window for the turn.
  const { args: psArgs, cleanup } = pwshWrapperArgs(command, [...prefix, ...args]);
  const child = spawn(pwsh, psArgs, { ...windowsCliTreeSpawnOptions(opts), env }) as ChildProcessWithoutNullStreams;
  child.once("close", cleanup);
  return child;
}

/** True when resolveCliCommand already handed us node (fakes / JS shims). */
function spawnDirectNode(command: string): boolean {
  return command === process.execPath;
}

// exposed for tests only
export const _internal = {
  shimScriptTarget,
  whereCache,
  windowsSpawnOptions,
  windowsCliTreeSpawnOptions,
  pwshWrapperArgs,
  spawnDirectNode,
};
