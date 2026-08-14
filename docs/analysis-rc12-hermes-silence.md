# rc.12 analysis: `hermesAgent exited 2` + "not responding at all" (incl. Codex after switching back)

Analysis only — no application code was changed. Everything below was read from, or executed
against, tag `v0.2.0-rc.12` (`3a52035`), tag `v0.2.0-rc.11` (`2786aeb`), and the shipped rc.12
Windows installer (`VelarixBot-Setup-0.2.0-rc.12-x64.exe`, checksum verified against
`SHA256SUMS.txt`). Line numbers refer to the rc.12 tag.

## TL;DR verdict

1. **Confirmed root cause of the visible error:** the Hermes driver spawns
   `hermes --approval-policy acp|never [-m <model>] acp stdio`
   (`server/drivers/acp/hermes.ts:41-47`). The `hermes` binary installed on Dyon's machine does
   not accept that argv. It printed its own usage/command list to stderr and exited with the
   classic usage-error status **2** before ever speaking ACP. The driver's `close` handler then
   emitted `hermesAgent exited 2 before the prompt result: <last 300 chars of stderr>`
   (`server/drivers/acp/core.ts:391-399`). The "plugin list" in the message is **the CLI's own
   subcommand list**, not anything VelarixBot passed — see the character math below. This spawn
   grammar was never validated against any real Hermes CLI anywhere (see Tests). Hermes turns in
   rc.12 can never work against that binary, on every platform, from first principles.
2. **The follow-on total silence (including Codex after switching back) is NOT reproducible on
   the shipped code path.** I ran the rc.12 server + built renderer end-to-end with a fake
   `hermes` that reproduces the exit-2 usage error byte-for-byte, in four scenarios (plain HTTP
   sequence; full UI; rapid-fire messages queued during the failing turn; an rc.11→rc.12
   upgraded profile with a pre-existing Codex bot). In every case each later message produced a
   visible `error: hermesAgent exited 2 …` chip, and switching back to Codex produced a normal
   reply — the per-bot `busy` flag and the driver's per-thread `active` map are both cleared on
   `runtime.error` **and** `turn.completed` (`server/services/turns.ts:656-698`,
   `server/drivers/acp/core.ts:213-229`). So rc.12's server-side session/lock handling is not
   the dead-session mechanism.
3. **The dead-session symptom matches exactly one state the code can get into: the renderer's
   optimistic `busy` flag stuck true.** The renderer sets `busy: true` locally the moment you
   hit Enter (`src/state/store.tsx:536-542`) and clears it **only** from SSE `bot` frames (or a
   failed POST). While `busy` is true, every send is **silently enqueued client-side and never
   POSTed** (`src/state/store.tsx:626-644`, `src/lib/prompt-queue.ts:13-15`), and switching the
   model to Codex clears none of `busy`/`queued` (`src/state/store.tsx:427-428`, `745-749`).
   One missed `busy:false` frame therefore silences the bot **for every provider, forever, with
   zero user feedback** — precisely "same dead-session feel" after switching back to Codex. Two
   concrete ways rc.12 can miss that frame are identified below (resync race; dead server
   process with no supervision). Which one bit Dyon can be distinguished by one action: **reload
   / restart the app** — if the transcript then shows error chips for the "silent" messages, the
   server was fine and the renderer was wedged; if the app shows the "Couldn't start the bot
   server" page or an empty state, the server process had died.
4. **This is current source, not packaging.** The installer was built by the release workflow
   from exactly the tag SHA, the packaged `resources/server/drivers/acp/hermes.js` /
   `acp/core.js` / `services/turns.js` match the tag source, and the shipped renderer bundle
   contains the P1.3 client (`lastEventId`, `resumed` markers). No stale-binary issue this time.

---

## 1. The driver, the exact spawn, and what "the prompt result" is

- Driver: `server/drivers/acp/hermes.ts` (new in [PR #61](https://github.com/Velarixx/VelarixBot/pull/61),
  merged between rc.11 and rc.12; never modified afterwards — `git log --follow` shows exactly
  one commit). It is an `AcpSupport` bundle over the generic ACP runtime
  `server/drivers/acp/core.ts`.
- Exact spawn (`hermes.ts:41-47`, executed at `core.ts:173-178` via `spawnCliHidden`):

  ```
  hermes --approval-policy acp -m gpt-5.6-sol acp stdio     (normal bot)
  hermes --approval-policy never acp stdio                  (fullAuto, no model)
  ```

  `hermes` is the bare PATH name by default (`hermes.ts:34`, overridable per instance via
  `config.cli`). No plugin/skill list is ever passed on argv — the only extras are the
  approval-policy pin and `-m`. MCP servers travel later inside `session/new` JSON-RPC params
  (`core.ts:147-163`), which this CLI never reached.
- "The prompt result" = the ACP `session/prompt` JSON-RPC **response**. ACP has no
  `turn/completed` notification; the prompt RPC result (stopReason + usage) is the turn's
  completion signal (`core.ts:8-9`, awaited at `core.ts:462-478`).
- The error string is produced by the child `close` handler (`core.ts:391-399`): if the process
  exits before the turn settled, it emits
  `` `${DRIVER_KIND} exited ${code} before the prompt result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}` ``.
  **Exit code 2 is the CLI's own exit status** — the conventional argv/usage-error code — merely
  relayed. It means the binary rejected the command line and never entered ACP stdio mode; the
  `initialize` request written to its stdin was never answered.

## 2. The trailing "plugin list" text — what the CLI thought it was asked

The message Dyon saw is a double truncation of the CLI's stderr:

- `core.ts:396` appends `stderr.trim().slice(-300)` — the **last 300 characters** of stderr.
- The fold that renders it into the chat truncates the whole message to 160 chars:
  `` `error: ${event.message.slice(0, 160)}` `` (`server/services/turns.ts:658`).

Character math: the prefix `hermesAgent exited 2 before the prompt result: ` is 47 chars;
`rator,pets,journey,learning,memory-graph,memory,tools,computer-use,mcp,sessions,insights,monitoring,claw,version,` is 113 chars; 47 + 113 = **exactly 160**. So:

- The leading `rator,` is the tail of `…orchestrator,` — `slice(-300)` cut into the middle of a
  word, meaning the CLI's usage output had ≥ 300 trailing chars of comma-separated names.
- The trailing `version,` is cut by the 160-char display cap; roughly 187 more characters of the
  list (and the actual `error: unknown option …` line above it) were captured but never shown.

So no, the driver did not pass a plugins/skills argument. The list is the **installed `hermes`
binary's own subcommand/plugin catalog from its usage error** (…orchestrator, pets, journey,
learning, memory-graph, memory, tools, computer-use, mcp, sessions, insights, monitoring, claw,
version, …). That catalog does not look like a focused coding-agent CLI; it is either a
different product squatting on the `hermes` name on Dyon's PATH, or a Hermes CLI whose real
interface differs from the "v0.2.0-rc.10 spec" PR #61 was grounded on. This repo cannot
distinguish those two — nothing in it ever talked to a real `hermes` binary (see Tests) — but
either way the driver's argv is wrong **for the binary actually installed**, and the
`--approval-policy`-before-subcommand grammar was asserted only against the in-repo fake
(`server/drivers/acp/hermes.test.ts:119-133` pins `["--approval-policy","acp","-m","gpt-5.5","acp","stdio"]`
against `server/testing/fake-acp-cli.ts`, which accepts anything).

Note the driver's `snapshot()` only runs `hermes --version` (`core.ts:494-499`), which the
installed binary answers happily — so the instance shows "available (authenticated)" in the
picker while every turn is guaranteed to die. There is no identity/grammar preflight.

## 3. Why later Hermes turns *should not* be silent — verified

Reproduced end-to-end on the rc.12 tag (server `node server/index.ts`, built renderer served via
`OMB_STATIC_DIR`, driven with Playwright) with a fake `hermes` that prints a usage error +
command list to stderr and exits 2:

- Every subsequent message — immediate or minutes later — produced a fresh spawn, a fresh
  `error: hermesAgent exited 2 …` chip, and `busy:false` / `state:BLOCKED` afterwards. SSE frame
  ordering observed: `message(user) → bot(busy:true) → turn.started → runtime.error →
  message(error chip) → bot(busy:false) → turn.completed → bot(busy:false)`.
- Messages typed **while** the turn was failing rendered as "Queued 1/2/3" chips and drained
  one-per-idle correctly after each failure (`src/state/store.tsx:777-781`,
  `src/lib/prompt-queue.ts:32-42`).
- The cleanup path is sound by inspection too: `settle()` deletes the per-thread `active` entry
  before emitting `turn.completed` (`core.ts:213-229`), and the fold clears `busy` on **both**
  `runtime.error` (`turns.ts:659`) and `turn.completed` (`turns.ts:685`); a synchronous
  `sendTurn` throw is also caught and clears `busy` (`turns.ts:914-926`). The event bus isolates
  subscriber exceptions (`server/harness/bus.ts:38-44`), so a throwing fold cannot kill the
  driver, and `bot.threadId` is never reassigned, so the fold cannot "lose" the bot.

So on the shipped code, "no response at all" for messages 2..n is **not** the server's behavior.
The two mechanisms that do produce exactly Dyon's symptom:

### 3a. Renderer stuck-busy wedge (most consistent with the transcript)

- `send` flips `busy:true` optimistically (`store.tsx:536-542`); a **successful** POST never
  clears it — only SSE `bot` frames do.
- While `busy || posting`, sends are converted to silent client-side queue entries and **no HTTP
  request is made** (`store.tsx:626-644`) — so a wedged client produces no 409s, no error
  banners, nothing in the server transcript. The user keeps typing into a void.
- `setModel` (the Hermes→Codex switch) patches only `modelSelection` — it clears none of
  `busy`, `queued`, or `posting` (`store.tsx:427-428`, `745-749`), so the wedge survives the
  provider switch. This is the "Codex is also dead" behavior: **Codex was never asked.**
- Even the Stop button cannot recover without SSE: interrupt POSTs, the server broadcasts
  `busy:false`, but the wedged/deaf client never applies it.
- A concrete rc.12 way to miss the `busy:false` frames exists in the resync path
  (`store.tsx:806-826`): `resync()` is not single-flighted; two overlapping resyncs share one
  `pendingDuringResync` buffer, the first `.then()` to finish drains it, and the later snapshot
  **sets the cursor backward** and hydrates older bot state (possibly `busy:true`, mid-turn)
  over newer state — the missed live frames are then permanently skipped by the dedupe cursor
  (`store.tsx:854-859`). Trigger requires ≥2 `hello.resumed === false` reconnects in quick
  succession (e.g. sleep/resume or a server hiccup while a turn is failing). I could not force
  this trigger in the sandbox; it is an audit finding, not a reproduced one.

### 3b. Dead server process with no supervision

- Electron main forks the server as a `utilityProcess` and only watches for exit **during
  startup** (`electron/main.mjs:39-55`); after boot there is no exit handler, no respawn, and no
  renderer notification. If the server process dies mid-session, the window stays up, SSE dies,
  every POST fails with only a transient 6-second banner (`store.tsx:599-624`), and typed
  messages vanish — across all bots and providers, until the app is restarted.
- The server installs no `uncaughtException`/`unhandledRejection` handlers (checked repo-wide),
  and the ACP/codex drivers never attach an `error` listener to `child.stdin` — `send()`'s
  try/catch (`core.ts:190-195`) only covers the synchronous call, so an asynchronous EPIPE
  against a fast-dying CLI would surface as an uncaught `'error'` event and kill the process.
  I did not manage to trigger this with the fake (the initialize write wins the race on Linux);
  it remains the plausible crash vector on a slower Windows pwsh-wrapped spawn chain.

Distinguishing 3a vs 3b on Dyon's machine: restart the app and look at the same chat. Persisted
error chips for the "silent" messages ⇒ server was alive, renderer was wedged (3a). No chips ⇒
the messages never reached the server (3b, or the client queue which is memory-only). The
`~/.velarixbot/events/<threadId>.ndjson` tee (`server/harness/bus.ts:32-37`) will show whether
turns 2..n ever started.

## 4. Hermes→Codex switch mechanics (server side) — checked, sound

- `PATCH /api/bots/:id { modelSelection }` (`server/routes/bots.ts:148-209`) just swaps the
  selection; the thread, transcript, and per-instance `resumeCursors` map are kept. No in-flight
  turn is interrupted (interrupt targets whatever the **current** selection is,
  `turns.ts:999-1009`), and the next turn resolves the adapter from the new selection
  (`turns.ts:765`) with `resumeCursor: bot.resumeCursors[bot.modelSelection.instanceId]`
  (`turns.ts:882`) — so a Hermes ACP session id is never handed to Codex; Codex gets its own
  cursor (and falls back from `thread/resume` to `thread/start` on a bad one,
  `server/drivers/codex.ts:546-580`, pinned by `codex.test.ts:333-338`).
- Failed Hermes turns never wrote a Hermes cursor anyway: `session.started` (the only cursor
  writer, `turns.ts:549-552`) requires a successful `session/new`, which exit-2 never reached.
- Live-verified on rc.12 (fake codex app-server + fake hermes): codex reply → switch to hermes →
  two exit-2 error chips → switch back to codex → normal reply reusing `codex-thread-1`. Also
  verified on an rc.11-created profile imported into rc.12's SQLite store.
- rc.11→rc.12 codex driver diff is confined to computer-MCP mounting and the `cloudComputer`
  capability flag; spawn (`["app-server"]`), approvals, and session handling are unchanged. **No
  rc.12 regression silences Codex on its own** in any flow I ran, including with the SQLite
  import, the P0 approval changes, and the P1.3 SSE stream active.

## 5. Installer/packaging — ruled out

- The rc.12 release run (`31794631923`) built exactly tag SHA `3a52035`; `release.yml` runs
  `verify-packaged-server` + a headless smoke on the packaged server for both OSes
  (`.github/workflows/release.yml:63-74`, `115-126`).
- I downloaded `VelarixBot-Setup-0.2.0-rc.12-x64.exe` (sha256 matches `SHA256SUMS.txt`),
  unpacked NSIS → `app-64.7z` → `resources/`: `server/drivers/acp/hermes.js` carries the same
  `--approval-policy … acp stdio` spawn, `server/drivers/acp/core.js:328-330` the same error
  string, `server/services/turns.js` the same busy-clearing folds, and the renderer bundle
  (`resources/ui/assets/index-BE6UWPlT.js`) contains the P1.3 resumable-SSE client. The mac DMG
  comes from the same workflow/SHA with the same verify steps.
- Conclusion: **current source**, not a stale/mispackaged binary.

## 6. Tests — why nothing caught this

- **Tier A (`ci.yml` → `pnpm test`)**: `hermes.test.ts` and the `scenarios.test.ts` hermes leg
  run against `server/testing/fake-acp-cli.ts`, a scripted fake that accepts whatever argv it is
  given. The argv test (`hermes.test.ts:119-133`) *pins the assumption* rather than validating
  it — it would pass with any grammar. Tier A cannot catch a real-CLI grammar mismatch by
  construction. It also doesn't cover the renderer busy/queue/SSE wedge (those are unit-tested
  in isolation, not against a deaf stream).
- **Tier B (`eval.yml`)**: has an optional real-Hermes leg gated on the `HERMES_AUTH_JSON`
  secret. Every recent run logs `hermes (HERMES_AUTH_JSON): absent (optional — never required)`
  and `Skipping optional Hermes scenario` — the secret was never configured, so the leg has
  **never executed**. On top of that, all recent eval runs conclude `failure` anyway, so a
  broken optional leg would not have gated anything.
- **`protocol-canary.yml`** exists for exactly this class of drift — but only for Codex.
- Net: **no tier ever executed `hermes … acp stdio` against a real binary.** PR #61 itself says
  it was "grounded on the v0.2.0-rc.10 spec"; unlike `acp/grok.ts` ("Verified against grok
  1.0.0"), `hermes.ts` carries no verified-against note (`acp/gemini.ts` at least admits it).

## Must-fix vs nice-to-have

Must-fix (rc.12 blockers):

1. **Validate and correct the Hermes spawn grammar** in `server/drivers/acp/hermes.ts:41-47`
   against a real, current Hermes Agent CLI install (which subcommand enters ACP stdio; whether
   `--approval-policy`/`-m` exist and where they may appear). Keep the approval pin only if the
   CLI supports it; otherwise enforce approvals purely through the ACP permission bridge.
2. **Preflight the binary, fail with a human answer**: before (or on the first) turn, verify the
   `hermes` on PATH is actually the expected agent CLI (help/`--version` scrape or a dry
   `initialize` handshake with a short timeout). On mismatch, emit "the `hermes` on PATH is not
   the Hermes Agent CLI (or is too old) — expected `hermes acp stdio` to speak ACP" instead of a
   truncated usage dump. `snapshot()`'s `--version`-only probe currently reports a guaranteed-
   to-fail instance as available.
3. **Make renderer stuck-busy impossible** (this is the dead-session mechanism):
   single-flight `resync()` and stop draining the shared `pendingDuringResync` buffer from two
   promises / setting the cursor backward over newer applied state (`src/state/store.tsx:806-826`);
   reconcile `busy` with the server on reconnect/focus (snapshot poll) instead of trusting the
   optimistic flag indefinitely; give queued sends visible state and let a drain attempt POST so
   the server's 409/"already working" can surface; clear or re-validate `busy`/`queued` on
   `setModel`.
4. **Supervise the server utilityProcess** in `electron/main.mjs` (post-boot exit handler:
   respawn and/or an explicit "bot server stopped" surface in the renderer), and add
   `uncaughtException`/`unhandledRejection` last-resort logging in `server/index.ts` plus
   `child.stdin.on("error", …)` in `acp/core.ts` and `codex.ts` so a fast-dying CLI can never
   take the whole server with it.

Nice-to-have:

5. Stop double-truncating driver errors: keep the full `runtime.error` text in
   `stateDetail`/tooltip, and prefer the stderr **head** (where `error: unknown option …` lives)
   over only the tail in `core.ts:396`.
6. Add a Hermes protocol canary mirroring `protocol-canary.yml`, gated on `HERMES_AUTH_JSON`;
   configure that secret; make `eval.yml` green so optional legs are meaningful.
7. Extend the driver-contract fixtures with a "CLI rejects argv / prints usage / exits 2" case
   asserting the user-facing message quality (not just `exit_before_result`).

## Answers to the specific questions

| Question | Answer |
|---|---|
| Where is the error produced? | `server/drivers/acp/core.ts:391-399` (`close` handler), displayed via `server/services/turns.ts:656-662` with a 160-char cap. |
| What does exit 2 mean there? | The CLI's own usage-error exit status, relayed; the process died parsing argv, before ACP `initialize`. |
| What is "the prompt result"? | The ACP `session/prompt` JSON-RPC response — the turn-completion signal (`core.ts:8-9`, `462-478`). |
| Is a plugins/skills argument passed wrongly? | No argument of that kind is passed at all; the list is the CLI's own usage output (stderr tail, `slice(-300)` then `slice(0,160)` — the math lands exactly on the observed string). |
| Why are later turns silent? | Not the server: verified recovering in all flows. Either the renderer's stuck-busy/silent-queue wedge (sends never leave the client; survives provider switch) or a dead unsupervised server process. App restart + the on-disk transcript distinguishes them. |
| Why is Codex-after-switch dead too? | Same wedge: the client never POSTs while it believes the bot is busy, and `setModel` clears nothing; server-side switching is sound (verified live, including cursor isolation). Codex-on-a-fresh-bot works in rc.12. |
| rc.11 vs rc.12? | Hermes is new in PR #61 (rc.12 is the first release with it) — there is no last-known-good Hermes path. Codex driver changes are confined to computer-MCP mounting + `cloudComputer` capability; no send-path/approval/session regression found or reproduced. |
| Installer or source? | Current source. Installer built from the tag SHA; packaged server and renderer match; checksums verified. |
| Would Tier A/B have caught it? | No. Tier A pins the argv against an accept-anything fake; Tier B's real-Hermes leg has never run (`HERMES_AUTH_JSON` absent) and eval runs were failing regardless; the protocol canary covers Codex only. |
