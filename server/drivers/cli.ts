// Windows CLI helpers.
//
// CLIs installed via npm/yarn/pnpm on Windows ship as .cmd batch shims
// (e.g. `codex.cmd` in %APPDATA%\npm). child_process cannot execute .cmd
// files directly — spawn/execFile fail with ENOENT/EINVAL unless the
// command runs through cmd.exe, and going through cmd.exe re-opens argv to
// its quoting and %VAR% expansion rules (the CVE-2024-27980 class — model
// names, personas, and MCP-config JSON all travel on argv here). Instead
// we resolve the shim to its real target and spawn THAT — no shell at all:
//   1. a vendored native .exe when the shim's JS entry is a launcher that
//      only re-spawns one (npm Codex: codex.cmd → bin/codex.js →
//      @openai/codex-win32-<arch>/vendor/<triple>/bin/codex.exe). The
//      driver's stdio pipes must bind to the process that actually speaks
//      the protocol — see nativeLauncherExe for the rc.13 field failure.
//   2. otherwise the JS entry itself under process.execPath (as node).
// Native installers (the claude installer → claude.exe) resolve to their
// .exe. A shim we cannot unwrap is NEVER routed through cmd.exe: probes go
// through the pwsh wrapper (args in a JSON file), and turn spawns fail
// with a clear error instead.
//
// Blocking notes: resolveCli shells out to `where` synchronously, at most
// once per CLI per minute (cached); everything else spawns async children.
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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

// Windows arch → rust target triple for the vendored-binary layout npm
// CLIs like @openai/codex ship. Same table as codex's own bin/codex.js.
const WIN_VENDOR_TRIPLES: Record<string, string> = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};

/**
 * npm-installed Codex is a LAUNCHER, not the CLI: bin/codex.js resolves the
 * native codex.exe out of the platform package (@openai/codex-win32-<arch>,
 * vendor/<triple>/bin/codex.exe — or the main package's own vendor/ dir)
 * and spawns it with stdio:"inherit", mirroring its exit code.
 *
 * Running that launcher from the packaged app is the rc.13 field failure:
 * the unwrap used to hand spawnCliHidden `process.execPath + codex.js`, and
 * packaged process.execPath is VelarixBot.exe — a GUI-subsystem binary.
 * PowerShell does not wait for (or wire stdio to) GUI-subsystem
 * executables, so wrap.ps1's `& VelarixBot.exe codex.js app-server`
 * returned immediately, `exit $LASTEXITCODE` made pwsh exit 0 having never
 * carried a protocol byte, and every turn failed as protocol_mismatch
 * ("`codex` exited 0 without speaking the app-server protocol"). Dev was
 * immune only because process.execPath there is node.exe, a console app.
 *
 * So: resolve the same native exe the launcher would spawn — mirroring its
 * search exactly (require.resolve of the platform package from the script's
 * own location, then the main package's vendor/ fallback) — and bind the
 * driver's stdio pipes to IT, one console-subsystem child, same as
 * claude.exe. The launcher's CODEX_MANAGED_BY_* env hints (update nagging
 * only) are intentionally skipped. Returns null when the script is not a
 * vendored-native launcher; callers then fall back to node + the JS entry.
 */
function nativeLauncherExe(script: string, arch: string = process.arch): string | null {
  const triple = WIN_VENDOR_TRIPLES[arch];
  if (!triple) return null;
  const pkgRoot = dirname(dirname(script)); // <pkg>/bin/codex.js → <pkg>
  let pkgName = "";
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { name?: unknown };
    pkgName = typeof pkg.name === "string" ? pkg.name : "";
  } catch {
    return null; // not a package-shaped install — plain JS entry
  }
  if (!pkgName) return null;
  const exe = basename(script).replace(SCRIPT_RE, "") + ".exe";
  const candidates: string[] = [];
  try {
    // the platform package, resolved the way the launcher's own
    // require.resolve does (npm global, pnpm, and nested layouts)
    const platformPkg = createRequire(script).resolve(`${pkgName}-win32-${arch}/package.json`);
    candidates.push(join(dirname(platformPkg), "vendor", triple, "bin", exe));
  } catch {
    /* platform package not installed — try the fat-package vendor dir */
  }
  candidates.push(join(pkgRoot, "vendor", triple, "bin", exe));
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Windows: turn a resolved .cmd/.bat shim into a spawnable command.
 * Prefers the vendored native exe (see nativeLauncherExe) over the shim's
 * JS entry; falls back to process.execPath-as-node + the JS entry; null
 * when the shim cannot be unwrapped at all. `arch` is a test seam — real
 * callers use this machine's arch.
 */
function windowsShimCommand(
  shim: string,
  arch: string = process.arch,
): { command: string; args: string[]; env?: Record<string, string> } | null {
  const script = shimScriptTarget(shim);
  if (!script) return null;
  const native = nativeLauncherExe(script, arch);
  if (native) return { command: native, args: [] };
  return {
    command: process.execPath,
    args: [script],
    // packaged: process.execPath is the Electron binary; run as plain node
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * How to spawn a CLI on this platform:
 * - `.ts` / `.js` scripts (test fakes): this process's node. Shebang
 *   execution is POSIX-only; Windows cannot exec a `.ts` file.
 * - POSIX binaries: the raw name (resolved via PATH by the shell-less spawn).
 * - Windows: the resolved .exe, or — for .cmd shims — the vendored native
 *   .exe the shim's JS launcher would spawn (npm Codex), else node running
 *   the shim's real JS entry. Neither needs cmd.exe at all.
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
    const unwrapped = windowsShimCommand(resolved);
    if (unwrapped) return unwrapped;
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

/** The path the CLI resolves to, for display in snapshot reasons and turn
 * failures — so a PATH-shadowed binary is identifiable ("which codex is
 * this?"). On Windows this is the executable a turn actually binds stdio
 * to (the vendored native .exe, the unwrapped JS entry, or the resolved
 * .exe) — not the .cmd shim in front of it. Display only, never used to
 * spawn. Falls back to the raw name. */
export function displayCliPath(cli: string, env?: NodeJS.ProcessEnv): string {
  if (/[\\/]/.test(cli)) return cli;
  if (IS_WIN) {
    const { command, args } = resolveCliCommand(cli);
    // node + JS entry: the entry identifies the install, not our own binary
    return command === process.execPath && args[0] ? args[0] : command;
  }
  const path = (env ?? process.env).PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    try {
      const candidate = join(dir, cli);
      if (existsSync(candidate)) return candidate;
    } catch {
      /* unreadable PATH entry */
    }
  }
  return cli;
}

/**
 * Protocol-identity probe: spawn `cli args` exactly like a turn would, write
 * one JSON-RPC line, and wait for the reply on stdout. A `--version` probe
 * alone cannot tell an impostor apart — a PATH-shadowed or outdated binary
 * answers `--version` fine and then rejects the real argv or never speaks
 * JSON (rc.12 field failure). Kills the child when done.
 *
 * `init` carries the RESULT of the message whose `id` matches `initMessage`
 * (the initialize response), so callers can inspect the handshake itself —
 * e.g. hermes derives the signed-in state from the advertised authMethods.
 * Any JSON-RPC object on stdout already proves protocol identity, so a
 * child that emits JSON but never answers the probe id (a notification-
 * first agent) still resolves ok — just without `init`.
 */
export function probeProtocol(
  cli: string,
  args: string[],
  initMessage: unknown,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; detail: string; init?: unknown }> {
  return new Promise((resolvePromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCliHidden(cli, args, {
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      resolvePromise({ ok: false, detail: (e as Error).message });
      return;
    }
    const expectId = (initMessage as { id?: unknown } | null)?.id;
    let sawJson = false;
    let done = false;
    const finish = (ok: boolean, detail: string, init?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killProcessTree(child.pid);
      resolvePromise({ ok, detail: detail.slice(-300), ...(init === undefined ? {} : { init }) });
    };
    const timer = setTimeout(
      () => finish(sawJson, sawJson ? "" : "no protocol reply before the probe timeout"),
      opts.timeoutMs ?? 8000,
    );
    timer.unref?.();
    let stderr = "";
    let buf = "";
    child.stderr.on("data", (c) => {
      stderr += c;
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && typeof msg === "object") {
            sawJson = true;
            if (expectId === undefined || (msg as { id?: unknown }).id === expectId) {
              finish(true, "", (msg as { result?: unknown }).result);
              return;
            }
            // JSON, but not the probe reply (a notification / side-channel)
            // — identity is proven; keep reading for the reply itself
          }
        } catch {
          /* non-JSON noise — keep waiting */
        }
      }
    });
    child.on("error", (e) => finish(false, `spawn failed: ${e.message}`));
    child.stdin.on("error", () => {
      /* the close handler reports the failure */
    });
    child.on("close", (code) =>
      finish(sawJson, sawJson ? "" : `exited ${code} before any protocol reply${stderr.trim() ? `: ${stderr.trim()}` : ""}`),
    );
    try {
      child.stdin.write(JSON.stringify(initMessage) + "\n");
    } catch {
      /* stream already gone — close will fire */
    }
  });
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
// Unwrapped JS entries still take the CLI-tree path when a wrapper
// exists — anything native they spawn must inherit a hidden console,
// not CREATE_NO_WINDOW. NB: only CONSOLE-subsystem targets belong under
// the wrapper; pwsh does not wait for or wire stdio to GUI-subsystem
// executables (the packaged-Electron rc.13 failure).
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
 * Test fakes (`.ts` / `.js` path as `cli`) spawn node directly with
 * windowsHide. Wrapping those in wrap.ps1 exits 0 without running the
 * script. Packaged Codex is an unwrapped `.cmd` resolved all the way to
 * the vendored native codex.exe (see nativeLauncherExe) — a console app
 * the pwsh wrapper waits for and wires stdio to, exactly like claude.exe.
 * It must NOT run as node + `codex.js`: packaged process.execPath is the
 * GUI-subsystem VelarixBot.exe, which pwsh fire-and-forgets (exit 0, zero
 * protocol bytes — the rc.13 protocol_mismatch field failure). Unwrapped
 * JS entries without a vendored exe still go through the hidden pwsh CLI
 * tree like native .exe: CREATE_NO_WINDOW on node would give any native
 * child no console to inherit, so it would flash a visible CMD window.
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
  const argv = [...prefix, ...args];
  // Test fakes: this process's node + a .ts/.js path. No native grandchild.
  // CREATE_NO_WINDOW hides the helper itself. Do not wrap in wrap.ps1.
  if (isTestScriptCli(cli) && spawnDirectNode(command)) {
    return spawn(command, argv, { ...helperOpts, env }) as ChildProcessWithoutNullStreams;
  }
  const wrapper = resolveCliTreeWrapper(argv);
  if (!wrapper) {
    if (SHIM_RE.test(command)) {
      throw new Error(
        `cannot run ${command}: it is a batch shim and PowerShell 7 is not installed. ` +
          `Install pwsh (winget install Microsoft.PowerShell) or reinstall the CLI natively.`,
      );
    }
    // no wrapper: hide the direct child (CREATE_NO_WINDOW). Grandchildren may
    // flash their own consoles — last resort without a hidden console tree.
    return spawn(command, argv, { ...helperOpts, env }) as ChildProcessWithoutNullStreams;
  }
  // pwsh passes argv to native .exe/.js targets verbatim, but a .cmd target
  // re-enters cmd.exe where %VAR% expands even inside quotes — refuse to
  // send metacharacters down that path rather than risk injection
  if (SHIM_RE.test(command) && argv.some((a) => CMD_META.test(a))) {
    throw new Error(
      `refusing to pass cmd.exe metacharacters to the ${command} shim — reinstall the CLI natively or via an installer that ships an .exe`,
    );
  }
  // Do not set windowsHide/CREATE_NO_WINDOW on this spawn. The wrapper is
  // hidden via -WindowStyle Hidden so codex.exe, MCP proxies, and
  // command-safety pwsh inherit one hidden console instead of each opening
  // a visible cmd window for the turn. Never attach to the user's terminal.
  const { args: psArgs, cleanup } = pwshWrapperArgs(command, argv);
  const child = spawn(wrapper, psArgs, { ...windowsCliTreeSpawnOptions(opts), env }) as ChildProcessWithoutNullStreams;
  child.once("close", cleanup);
  return child;
}

/** True when resolveCliCommand already handed us node (fakes / JS shims). */
function spawnDirectNode(command: string): boolean {
  return command === process.execPath;
}

/** Test fakes pass a `.ts`/`.js` path as `cli`. Packaged Codex is a bare name. */
function isTestScriptCli(cli: string): boolean {
  return SCRIPT_RE.test(cli);
}

/**
 * Packaged Windows answer path: wrap native .exe (codex.exe, claude.exe)
 * AND unwrapped node+js entries so grandchildren inherit a hidden console.
 * Test script CLIs stay on CREATE_NO_WINDOW.
 */
function shouldWrapCliTree(cli: string): boolean {
  return !isTestScriptCli(cli);
}

/** PowerShell 5.1 mangles embedded quotes — only a fallback for simple argv. */
function argsSafeForWindowsPowerShell(args: string[]): boolean {
  return !args.some((a) => /["']/.test(a) || CMD_META.test(a));
}

function windowsPowerShellPath(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** pwsh 7 preferred; Windows PowerShell 5.1 only when argv has no quotes. */
function resolveCliTreeWrapper(args: string[]): string | null {
  const pwsh = resolvePwsh();
  if (pwsh) return pwsh;
  if (!argsSafeForWindowsPowerShell(args)) return null;
  const ps = windowsPowerShellPath();
  return existsSync(ps) ? ps : null;
}

// exposed for tests only
export const _internal = {
  shimScriptTarget,
  nativeLauncherExe,
  windowsShimCommand,
  whereCache,
  windowsSpawnOptions,
  windowsCliTreeSpawnOptions,
  pwshWrapperArgs,
  spawnDirectNode,
  isTestScriptCli,
  shouldWrapCliTree,
  argsSafeForWindowsPowerShell,
  windowsPowerShellPath,
  resolveCliTreeWrapper,
};
