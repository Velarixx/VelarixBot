# Contributing to VelarixBot

Thanks for wanting to help — community PRs have already shipped in this repo, and more are welcome.
This file tells you how to get a working dev setup, what the codebase expects from a change, and what
makes a PR easy to merge. Read it once before opening anything; it's short on purpose.

## Ground rules

- **Small, focused PRs.** One concern per PR. A PR that ports a platform *and* adds a feature *and*
  refactors will be asked to split. Big changes: open an issue first and agree on the approach.
- **Match the altitude.** This codebase is deliberately small and direct — plain Node, no frameworks
  on the server, one store, one event bus. Don't introduce a dependency where thirty lines of code
  will do. New runtime dependencies need a reason in the PR description.
- **Keep it green.** `pnpm typecheck && pnpm test` must pass. Server changes need tests (see below).
- **UI changes need screenshots.** Before/after images in the PR body; video for anything animated.
  Match the existing palette and tone in [`src/styles.css`](src/styles.css).

## Dev setup

Requirements: **Node 24+**, **pnpm**, and for actually chatting with a bot, at least one agent CLI
([`claude`](https://claude.com/claude-code) or [`codex`](https://github.com/openai/codex)) installed
and logged in. macOS is the primary platform; the harness server itself is portable Node and the
test suite runs on macOS, Linux, and Windows.

```sh
git clone https://github.com/Velarixx/VelarixBot && cd VelarixBot
pnpm install

pnpm dev:server    # harness server → 127.0.0.1:8799
pnpm dev           # app → http://127.0.0.1:5199
pnpm dev:desktop   # Electron shell (macOS)

pnpm typecheck     # app + server
pnpm test          # vitest suite (server unit + driver contract + API smoke)
pnpm test:watch    # same, in watch mode
pnpm eval          # Playwright + judge against :8799 (skips without secrets)
```

Eval secrets (values stay in Actions / your env — never commit them): `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`. `XAI_API_KEY` is optional and never required.

## Repo map

| Path | What lives there |
|---|---|
| `server/contracts.ts` | The driver SPI and canonical runtime event types. The whole architecture in one file — read it first. |
| `server/drivers/` | One file per provider (Claude, Codex, Grok, cloud computer). Adding a provider = one file + one registration line in `builtIn.ts`. |
| `server/harness/` | Registry (configs → live instances, unknown → shadow) and the fan-in event bus. |
| `server/db/` + `server/repositories/` | The one store: SQLite (better-sqlite3, WAL) behind repositories, plus the legacy-JSON importer and NDJSON export. `db/sqlite-native.ts` is the ONLY file allowed to load better-sqlite3 (packaging rule, test-enforced). |
| `server/services/` | Domain services (turn dispatch, bots, routines scheduler, teach). Clock-injectable — schedulers take `now` and `tick()`, no timers inside. |
| `server/routes/` | The HTTP + SSE API the app talks to. Routes call services and must not import persistence (test-enforced). |
| `server/app.ts` + `server/index.ts` | `createApplication({repos, providers, clock, …})` is the composition root; `index.ts` reads env, opens the database, and listens. |
| `server/testing/` | Test fakes: an in-memory driver, plus scripted fake `claude` / `codex` CLIs. |
| `src/` | The React chat app. No transports of its own — HTTP commands out, one SSE stream in. |
| `electron/` | Desktop shell: dictation, screen capture, local computer-use daemon. macOS-specific code lives here, gated. |
| `dist-server/` | **Build output, gitignored.** Never hand-edit, never commit — `pnpm build:server` regenerates it at package/release time. |

Data lives in `~/.velarixbot/`: `velarixbot.db` (SQLite, WAL — bots, transcripts, routines, event log),
`blobs/` (content-hash screenshot bytes; file bytes never go into SQLite), per-thread NDJSON event logs,
and config with keys. Legacy JSON stores import automatically on boot (backed up first, originals untouched).

## Tests

The suite is colocated (`server/**/*.test.ts`) and runs with `pnpm test`. Three layers:

- **Unit** — registry, bus, store. Pure in-process, use the fake driver in
  [`server/testing/fake-driver.ts`](server/testing/fake-driver.ts).
- **Driver contract** — [`claude.test.ts`](server/drivers/claude.test.ts) and
  [`codex.test.ts`](server/drivers/codex.test.ts) spawn the scripted fake CLIs in `server/testing/`
  and assert the canonical event stream, argv/env hygiene, interrupts, and the permission broker.
  Failure modes are toggled by env var (`FAKE_CLAUDE_MODE=exit-early`, etc.) — extend those fakes
  rather than mocking `child_process`.
- **API smoke** — [`index.test.ts`](server/index.test.ts) boots the real server against a throwaway
  home directory and exercises the HTTP surface.

House rules for tests:

- **No sleeps.** Wait on the event that proves the behavior (see `server/testing/events.ts`'s
  `recordEvents(...).until(...)`). A test that needs a timeout to pass is wrong.
- **Never touch the real `~/.velarixbot`.** The setup file points `HOME` at a temp dir; keep it
  that way.
- Tests that must spawn a shebang script are gated `describe.skipIf(process.platform === "win32")`
  until Windows CLI spawning lands — don't add new POSIX-only tests without that gate.

## Adding a provider driver

The SPI in [`server/contracts.ts`](server/contracts.ts) is deliberately small. A driver PR should:

1. Add `server/drivers/<name>.ts` implementing `ProviderDriver` and register it in
   [`builtIn.ts`](server/drivers/builtIn.ts).
2. `decodeConfig` **throws** on invalid config; `create` **rejects** (never throws synchronously) on
   failure — the registry downgrades both to an unavailable shadow instead of crashing the fleet.
   Do not remove or work around that behavior; it's what makes configs forward/backward compatible.
3. Emit only canonical `RuntimeEvent`s carrying your own `driverKind` — the bus drops cross-driver
   events on the floor.
4. A missing/broken CLI must surface as `snapshot() → { state: "unavailable", reason }`, and a
   failed spawn as a failed turn — never a hang, never a crash.
5. Bring a contract test following the fake-CLI pattern (scripted fake process + `recordEvents`).

## Platform rules

- The harness (`server/`) must stay portable Node. Anything macOS-only (TCC, Swift helpers,
  `~/Library` paths) belongs in `electron/` behind a `process.platform === "darwin"` gate.
- **Never build command strings for a shell.** No `shell: true`, no spawning through `cmd.exe` with
  quoted strings — model names, personas, and MCP config JSON travel through argv, and cmd.exe
  metacharacter expansion is a real injection class. On Windows, resolve `.cmd` shims to their JS
  entry and spawn `process.execPath` instead.
- POSIX-only calls (`process.kill(-pid)`, unix sockets) need a gated Windows equivalent
  (`taskkill /T`, named pipes) — not a silent failure.

## Secrets

API keys are write-only: they land in `~/.velarixbot/config.json` via `PUT /api/config` and the API
only ever reports `configured` booleans. Keep it that way — no logging keys, no echoing them in
responses or events, no baking them into argv where another local process could read them.

## Before you open the PR

- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] New server behavior has a test; driver changes keep the contract tests green
- [ ] No `dist-server/` churn, no lockfile churn beyond your actual dependency change
- [ ] macOS-only code is platform-gated; nothing breaks the packaged app
- [ ] UI changes include before/after screenshots

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
