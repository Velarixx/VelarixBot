# rc.8 Windows field-bug addendum — source verification report

Date: 2026-08-13. Analysis only; no application code was changed.

Scope inspected: `main` (0b9d897), tag `v0.2.0-rc.8` (c18a13a — one release-config-only commit behind `main`), tags rc.3–rc.7, merged PRs #47–#50, and the **actual shipped rc.8 Windows installer** (`VelarixBot-Setup-0.2.0-rc.8-x64.exe` downloaded from the GitHub release and unpacked).

## Executive summary

**All of the field observations are real, and none of them are bugs in the rc.8 send path. The installed rc.8 app does not run rc.8 server code.** The packaged app ships and executes an **rc.3-vintage compiled server** that predates the agents/memory MCP overlay for Codex, `create_bot`, `developerInstructions`, the per-bot memory system, and the Codex response-options gate.

Root cause chain (verified end to end, including inside the shipped installer):

1. `dist-server/` (the compiled server the packaged app runs) is **committed to git**. It was last rebuilt at commit ea384a3 — which is exactly tag `v0.2.0-rc.3`.
2. The release workflow does run `pnpm build:server` (`.github/workflows/release.yml` lines 54 and 99 via `package:win`), **but the build output no longer lands where the app loads it**. Commit 29ecf61 (PR #28, shipped as rc.6) added `electron/update-feed.mjs` to the tsconfig include (`tsconfig.server.json` line 18). With inputs now spanning `server/` and `electron/`, tsc's inferred rootDir became the repo root, so `tsc -p tsconfig.server.build.json` emits `dist-server/server/index.js` and `dist-server/electron/update-feed.mjs` — it never overwrites the tracked flat `dist-server/index.js`. Reproduced locally on `main`: `pnpm build:server` creates only untracked `dist-server/server/` + `dist-server/electron/` directories.
3. `electron-builder.yml` (lines 24–25) packs the whole `dist-server` directory into `resources/server`, so the installer contains **both** trees. Confirmed by unpacking the shipped rc.8 exe: `resources/server/index.js` (stale flat tree) **and** `resources/server/server/index.js` (fresh rc.8 compile) are both present.
4. `electron/main.mjs` line 34 forks `path.join(process.resourcesPath, "server", "index.js")` — **the stale flat tree**. Byte-compared: the shipped `resources/server/drivers/codex.js` and `resources/server/index.js` are identical to the rc.3 checked-in `dist-server` files modulo CRLF (Windows CI checkout).

Consequences: every installer since **rc.6** (rc.6, rc.7, rc.8, macOS and Windows alike) runs the rc.3 server. The rc.7 hotfix "Codex A/B/C not cards, create_bot on start+resume" (94027d8) never reached any installed build. The user's model, `gpt-5.6-terra`, appears in the stale driver's hard-coded catalog — consistent.

The rc.3 server explains every single wire observation in the addendum (see claims 1–2). PRs #47–#50 did **not** regress the send path (verified by diff; they only added memory MCP, images, credential-handoff classification, and switched Composio to a stdio proxy).

## Verdicts

| # | Claim | Verdict |
|---|-------|---------|
| 1 | agents+memory MCP never reach the codex CLI | **Confirmed observation, refined root cause**: stale rc.3 server in the package; source gates are correct |
| 2 | response-options prompt + cards active on codex despite the gate | **Confirmed observation, refined root cause**: same stale server; the gate only exists since rc.7 and never shipped |
| 3 | codex bundled plugins leak into bots | **Confirmed as a real, unmitigated gap** (grounding exists in source but never shipped and is conditional; no plugin-disable attempt anywhere) |
| 4 | codex sandbox cwd is the user's home | **Confirmed — true in current source too**, not just the stale build |
| 5 | reinstall residue / orphaned `.bak`, no reset action | **Confirmed with details** |
| 6 | grounding gap for tool-less OpenRouter/OmniRouter bots | **Confirmed** |
| — | Tier B pipeline in place? | **Partial**: all pieces exist and are runnable, but CI has never run it, and as designed it would **not** have caught claims 1–2 |

---

## Claim 1 — agents/memory MCP never reach the CLI

**Verdict: the observation is confirmed; the hypothesized root causes are refuted; the "installed binary diverges from the rc.8 tag" suspect is confirmed in a specific, provable form.**

What the addendum cites in source is accurate:

- `server/drivers/codex.ts` 528–534: `capabilities.agentsMcp: true`.
- `server/drivers/codex.ts` 51–80: overlay builder (`mcpServersFromIntegrations`, including `memory` at 76–78); 165–166: `mcpOverlay = { mcp_servers: … }`; applied to `thread/resume` at 469 and `thread/start` at 485.
- `server/index.ts` 746–748: depth-0 mounting of `integrations.agents` for any driver with `agentsMcp === true` (codex qualifies, no other condition); 749–751: `integrations.memory` unconditionally for such drivers.

So on rc.8 **source**, a first user turn on a codex bot always sends `config.mcp_servers.agents` + `.memory` on `thread/start`, plus `developerInstructions`. A thread/start of exactly `{cwd, model, sandbox, approvalPolicy, ephemeral}` is **impossible** on this code.

It is exactly what the **rc.3** driver sends. Stale `dist-server/drivers/codex.js` (shipped as `resources/server/drivers/codex.js`, verified byte-identical modulo CRLF) line 316–321: `thread/start` with precisely `{cwd, model, sandbox, approvalPolicy, ephemeral}` — no `config`, no `developerInstructions`, no overlay code at all. Its capabilities are `{ sessionModelSwitch: "unsupported" }` (line 356) — no `agentsMcp` — so the stale `index.js` never mounts agents for codex; memory MCP does not exist in rc.3 at all. `create_bot` doesn't exist either (it landed in rc.5, 29e3bf3). Hence: `startupStatus` lists only `codex_apps` and `node_repl` (the CLI's own bundled servers from the user's `~/.codex`), the model has no `create_bot` tool, fabricates "the bot is ready", and no `bot.added` broadcast can occur.

Ordered suspects, adjudicated:

- **Packaged-app spawn spec (Electron execPath / ELECTRON_RUN_AS_NODE / asar)**: refuted as the cause. The proxies are correct-by-design: `ELECTRON_RUN_AS_NODE: "1"` is set for every proxy (`server/index.ts` 109, codex.ts 47), proxies are spawned via `process.execPath` (`server/index.ts` 113, 131, 142), and the `.ts` → `.js` path fallback (`server/index.ts` 96–107, codex.ts 40–43) resolves inside `resources/server`, which is an `extraResources` directory **outside** the asar — no asar-unpack issue exists. (Caveat: this path has never been exercised on a packaged Windows build by any test; see Tier A/B gaps. But it is not what the field log shows — a broken spawn would still put the `config` key on the wire and produce startup errors for `agents`/`memory`.)
- **Regression from PR #47–#50 send-path refactors**: refuted. Diff rc.7 → rc.8 for `server/index.ts` and `server/drivers/codex.ts` shows the agents gate untouched, the memory mount *added* (`+ integrations.memory = memoryIntegration(bot.id)`), Composio moved to a stdio proxy, and image/handoff additions. Nothing removes the overlay or gates.
- **Installed rc.8 binary diverging from the rc.8 tag**: confirmed, with a precise mechanism. The installer *was* built from c18a13a by run 31729976352 (headSha verified), but its **payload server** is rc.3 code because of the packaging bug above. Tag-vs-HEAD divergence is negligible (one release-config commit).

Tests pass because: codex driver spawn tests (`server/drivers/codex.test.ts` line 21 `posixOnly = describe.skipIf(win32)`, suites at 74 and 127) run against `server/testing/fake-codex-app-server.ts` and are skipped on Windows; the Tier A scenario runner (`server/scenarios.test.ts`) is cross-platform but Windows CI is opt-in only (`.github/workflows/portable.yml`, `workflow_dispatch`, **zero runs to date**; `ci.yml` is Ubuntu-only per PR #51/#52); and — decisive — **every test and the eval boot the server from `server/index.ts` source** (`server/testing/harness.ts` 215, `eval/run.mjs` 173). Nothing anywhere executes `dist-server` or the packaged entry.

**Recommended fix (must-fix, release-blocking):**

1. Stop tracking `dist-server/` in git (`git rm -r --cached`, add to `.gitignore`). A committed build artifact that the packager trusts is the root hazard.
2. Fix the emit layout: give `tsconfig.server.build.json` an explicit `rootDir` (or compile the server and `electron/update-feed.mjs` as separate projects) so `dist-server/index.js` is the real, current entry; or point `electron/main.mjs` and `electron-builder.yml` at the nested layout. Either end is fine; they must agree.
3. Add a release-verification step (in `release.yml` next to the existing DMG/exe checks) that fails the build if the packaged `resources/server/index.js` does not match the just-compiled output — e.g. compare a hash, or assert on a version/commit stamp injected at build time and echoed by `/api/health`.
4. Rebuild and ship rc.9 from this; every fix landed since rc.5 (create_bot on codex, A/B/C suppression, memory, teach, handoff…) is currently invisible to installed builds.

## Claim 2 — response options / A/B/C cards on codex

**Verdict: confirmed observation, same root cause as claim 1 — refined.**

Source is as the addendum says: `server/response-options.ts` 27–29 (`shouldAttachResponseOptions(provider) { return provider !== "codex" }`), applied at `server/index.ts` 434 (fallback-card capture) and 777 (prompt attachment). On rc.8 source, a codex turn carries no `velarix_options` instruction and never yields the "What would you like to do?" fallback card.

But that gate only exists since rc.7 (94027d8) — and per claim 1, no installer since rc.6 contains it. The stale rc.3 server appends `responseOptionsPrompt` unconditionally (`dist-server/index.js` line 461) and — the tell-tale detail — the rc.3 codex driver has no `developerInstructions` support, so it **prepends the whole system prompt onto the user text inside `turn/start.input`** (stale codex.js line 329: `text: turn.system ? \`${turn.system}\n\n${turn.text}\` : turn.text`). That is precisely why the human's log shows the "append exactly <velarix_options>[...]" contract inside the outbound `turn/start` input — a wire shape the rc.5+ source cannot produce (from rc.5 on, system goes to `developerInstructions`; codex.ts 489).

**Shared root cause with claim 1: yes — and it is not a "send path that skipped both gates" in current code; it is that the shipped server predates both gates.** One fix (the packaging fix above) closes claims 1 and 2 together. No source change to the send path is needed for either.

## Claim 3 — codex bundled plugins leak into bots

**Verdict: confirmed as an unmitigated exposure; the specific field behavior is consistent with, and amplified by, the stale server.**

Facts from the repo:

- `codex_apps`, `node_repl`, and `~/.codex/plugins/cache/openai-bundled/...` (including the `control-in-app-browser` skill) belong to the user's codex CLI installation, not to VelarixBot. Nothing in this repo mounts them — and nothing disables them. There is no reference to plugins, plugin disabling, or bundled-skill suppression anywhere in `server/` (grep for `plugin` matches only Composio marketplace comments).
- Can the overlay disable them? Unknown from this repo — the `thread/start`/`thread/resume` `config` is a SessionFlags-style overlay (codex.ts 462–465 comment), so **if** the CLI version in the field exposes a config key for disabling bundled plugins/skills, it could ride the same overlay. The repo has never attempted or tested it. This needs verification against the codex CLI (the driver comment pins "codex-cli 0.144.4"), not against this codebase.
- Prompt grounding: current source has partial grounding, all of it post-rc.3 and therefore not in any shipped installer:
  - `server/index.ts` 784 (only when `integrations.agents` is mounted): "create_bot creates a real sidebar bot … Never invent Codex or conversation-only sub-agents … Never create bots with the shell, PowerShell, or by writing scripts — only create_bot."
  - `server/drivers/codex.ts` 98–99 (`CONVERSATIONAL_INPUT_NOTE`): "If they asked to create a bot, call the create_bot tool — never the shell."
  - There is **no** grounding anywhere stating that no in-app browser exists, so nothing counters the bundled `control-in-app-browser` skill or `node_repl` improvisation. And the create_bot grounding disappears whenever agents isn't mounted (comms depth ≥ 2).

**Recommended fix:** (must-fix, small) extend the codex persona/system text with capability-negative grounding — no in-app browser, no ChatGPT desktop environment, sidebar bots only via create_bot — unconditionally for codex-driven turns, not only when agents mounts. (Nice-to-have) investigate a config-overlay or CLI flag to exclude bundled plugins for VelarixBot-owned threads and pin it in a driver test against the fake app-server.

## Claim 4 — sandbox cwd is the user's home

**Verdict: confirmed — and it is true of current source, not just the shipped stale build.**

- `server/drivers/codex.ts` 479: `cwd: turn.cwd ?? homedir()` on `thread/start` (same at 174 for the process spawn), with `sandbox: "workspace-write"` and `approvalPolicy: "on-request"` when `fullAuto` is off (481–482).
- No caller ever sets `turn.cwd`: `server/index.ts` `startTurn` → `sendTurn` (767–796) passes no `cwd`; `contracts.ts` 119 declares the optional field, and the only non-test assignments are the `?? homedir()` fallbacks (claude.ts 357 and acp/core.ts 154 behave the same).
- There is no per-bot workdir anywhere. `~/.velarixbot` holds `config.json`, `bots.json`, `messages-*.json`, `events/`, `native/`, `memory/` (`server/config.ts` 28–47) — none of it is used as a sandbox root. No `work/<botId>` concept exists.

So on Windows a non-fullAuto codex bot runs with the entire `C:\Users\<name>` writable without approval (workspace-write semantics), exactly as the addendum says.

**Recommended fix (must-fix):** create and pass a per-bot workdir (e.g. `~/.velarixbot/work/<botId>`) as `turn.cwd` from `startTurn`, for all CLI drivers, and assert it in driver tests. This also gives deleteBot a directory to clean.

## Claim 5 — reinstall residue

**Verdict: confirmed, with precise mechanics.**

- `~/.velarixbot` intentionally survives reinstall; `INTERNAL_INSTALL.md` (Updates section) documents that bots/transcripts/settings persist across manual updates. There is **no documented uninstall story** — the file has install and update sections only; nothing says what to delete to fully remove the app.
- Orphaned `.bak`: confirmed. `server/store.ts` 51–56 (`atomicWrite`) copies every current file to `<path>.bak` before rename — including per-thread `messages-<threadId>.json`. `deleteBot` (store.ts 166) unlinks only `messagesFile(b.threadId)`, never the `.bak`; the HTTP DELETE handler (`server/index.ts` 1115–1133) additionally removes `events/<threadId>.ndjson` and `native/<threadId>.ndjson` but no `.bak` either. So every deleted bot leaves a `messages-<threadId>.json.bak` corpse forever (and `bots.json.bak` transiently retains deleted bot records until the next save).
- "Reset workspace…" action: **does not exist.** `src/components/AppSettingsPanel.tsx` has no reset; the only "Reset" button in the app (`src/components/SettingsPanel.tsx` 154–159) resets a bot's avatar color/expression/shape.

**Recommended fix (nice-to-have):** delete `${messagesFile}.bak` in `store.deleteBot`; add an uninstall/cleanup note to `INTERNAL_INSTALL.md`; optionally a Reset-workspace action gated behind a confirmation.

## Claim 6 — grounding gap for tool-less bots

**Verdict: confirmed.**

OpenRouter/OmniRouter ride `createOpenAICompatDriver` (`server/drivers/openrouter.ts`, `omnirouter.ts`), which is chat-only ("no MCP/tools on this driver" — openrouter.ts line 2) and declares `capabilities: { sessionModelSwitch: "in-session" }` (`server/drivers/openai-compat.ts` 240) — no `agentsMcp`, no `localComputerMcp`. Consequently `server/index.ts` mounts nothing, and the system prompt for such a bot is just persona + memory text + the response-options contract (774–777). Every capability sentence in the prompt is **additive and conditional** (783–793); there is no line telling a tool-less bot that it cannot create bots, run commands, or browse. The generic persona line (index.ts 705) says "do not implement the user's repo…" but nothing capability-aware.

**Recommended fix (must-fix, one line):** when neither agents nor computer nor composio integrations are mounted, append an explicit "You have no tools: you cannot create bots, run commands, browse, or modify files — say so instead of pretending" sentence.

---

## Tier B pipeline status: PARTIAL — built and runnable, never run in CI, and blind to this failure class

What exists (all landed in PR #42 / commit 344ebe2, "P1-B"):

- **Playwright flow**: `eval/flow.mjs` — real Chromium against the production UI on `127.0.0.1:8799` (vite-built `dist`, served by the harness server). Completes onboarding, creates three persona bots (Support/Ops/Research; optional Grok), assigns real instances (prefers codex/claude), sends one prompt each, watches for streaming, clicks Allow on permission cards, captures screenshots and transcripts.
- **Real-CLI seeding**: `eval/run.mjs` 64–83 + `eval/secrets.mjs` — writes `CODEX_AUTH_JSON` to a temp `HOME/.codex/auth.json`, forwards `CLAUDE_CODE_OAUTH_TOKEN`; `eval.yml` installs the real `@openai/codex` and `@anthropic-ai/claude-code` CLIs (lines 40–46). Grok/xAI optional.
- **LLM judge**: `eval/judge.mjs` — grok-3-mini scoring inPersona / addressedRequest / **noFabricatedCapabilities**, explicitly report-only ("a low score must never fail the eval job").
- **Mechanical hard-fails**: `eval/run.mjs` 32–44 — server up, UI reachable, onboarding done, three bots created, at least one stream observed. Exit 1 on miss.
- **CI wiring**: `.github/workflows/eval.yml` — `workflow_dispatch` **only** ("Manual only while Actions minutes are tight"), skips cleanly without secrets, uploads `eval-artifacts/`. `package.json` has the `eval` script and `playwright ^1.62.1` in devDependencies.

Status assessment:

- **Runnable today**: yes, locally or by dispatching the workflow, given `CLAUDE_CODE_OAUTH_TOKEN` and/or `CODEX_AUTH_JSON`. No stubs or TODOs; the code is complete for what it does.
- **Has it ever run in CI**: no — `gh run list --workflow eval.yml` returns zero runs. (The Windows/macOS `portable.yml` test workflow has also never run.)
- **Planned vs missing**: nightly scheduling (the PR title says "nightly" but the trigger is manual-only), a create-a-bot scenario, judge-as-gate, Windows runner, and — the important one — any leg that exercises the **packaged** app.
- **Would a working Tier B have caught claims 1–3?** As currently designed, **no for 1–2, partially for 3.** `eval/run.mjs` line 173 spawns `server/index.ts` from **source** — the exact code that is correct. The stale-`dist-server` payload never executes in the eval, so the missing MCP overlay and the A/B/C cards would not reproduce. The judge's `noFabricatedCapabilities` axis might have flagged claim-3-style fabrication in a transcript, but it is report-only and none of the three scenarios asks the bot to create a bot. The addendum's assertion that Tier B "would have caught" these is therefore wrong for the actual root cause — unless Tier B is pointed at the packaged artifact, which is the fix to make.
- **Relation to win32 skipIf gaps**: same blind spot, different layer. Driver-level codex e2e is `posixOnly` (`codex.test.ts` 21) and the cross-platform Tier A scenario runner (`scenarios.test.ts`, no skip, using the Windows-safe fakes from PR #41 — `cli.ts` runs `.ts` fakes via `process.execPath`) only runs on Windows via the never-dispatched `portable.yml`. But even un-skipped, all of these run source, so none would have caught the packaging bug either. The win32 skips would matter for genuinely Windows-specific spawn issues (pwsh wrapper, cmd-shim unwrapping in `server/drivers/cli.ts`) — a real risk surface that is currently untested in CI.

## Tier A regression-coverage gaps vs the addendum's asks (noted, not implemented)

1. *Windows real-CLI (or packaged-spawn-mirroring) smoke asserting `mcp_servers.agents`+`.memory` on thread/start and create_bot → bot.added*: **gap confirmed** — exists only as `posixOnly` fake-server assertions (`codex.test.ts` 403–437, 496–529) plus a create_bot round trip on a fake ACP driver (`scenarios.test.ts` 279–293), never on Windows CI, never against the packaged spawn path.
2. *Assert codex turns never contain `velarix_options` outbound and never produce fallback cards*: **gap confirmed** — `shouldAttachResponseOptions` has unit tests, but no test inspects a codex turn's outbound `turn/start.input` for the marker, and no scenario asserts the absence of the fallback card on codex.
3. *Assert codex `thread/start.cwd` is a per-bot workdir*: **not implementable yet** — no per-bot workdir exists (claim 4); the test should come with that fix.
4. *Un-skip win32 e2e legs*: partially done (scenario runner + Windows-safe fakes, PR #41), but codex/claude/acp driver spawn suites remain `posixOnly`, and no Windows job runs on PRs at all (`ci.yml` Ubuntu-only; `portable.yml` manual with zero runs).
5. **Missing from the addendum's list, and the highest-value one**: a packaged-artifact test — assert the app the installer ships actually contains and boots the current server (hash or version-stamp check in `release.yml`, and/or point one Tier B leg at the packaged binary).

## Must-fix vs nice-to-have

Must-fix (release-blocking, in order):

1. **Packaging**: untrack `dist-server/`, fix the tsc output layout vs the `main.mjs`/`electron-builder.yml` load path, add a release-time verification that the packaged server matches the built source (claims 1+2; the entire rc.6→rc.8 install base is affected on both OSes).
2. **Per-bot sandbox cwd** for CLI drivers instead of `homedir()` (claim 4 — a safety issue: home-wide workspace-write with no approvals).
3. **Capability-negative grounding**: codex "no in-app browser / create_bot only" unconditionally (claim 3), and a "you have no tools" line for tool-less drivers (claim 6).
4. **CI floor**: dispatch `portable.yml` and `eval.yml` at least once per release candidate; or make eval scheduled (nightly) as its PR intended, and add the packaged-server verification to `release.yml` (this is the piece that would have caught this incident).

Nice-to-have:

5. `deleteBot` removes `messages-*.json.bak`; document uninstall; optional Reset-workspace action (claim 5).
6. Un-skip / port the `posixOnly` driver suites on Windows; add the `velarix_options`-absence and `mcp_servers`-presence assertions to the scenario runner.
7. Investigate a codex-CLI config key to exclude bundled plugins for VelarixBot threads (claim 3, pending CLI verification).
8. Tier B additions: a "create me a bot" scenario asserting `bot.added`, a leg that runs against the packaged app, nightly schedule.

## Does the addendum's sequencing still hold?

Mostly yes, but re-scoped. "rc.9 in the current P0 wave" holds — with the crucial correction that **rc.9's content is primarily release engineering, not send-path fixes**: claims 1 and 2 are already fixed in source and have been since rc.5–rc.7; shipping them requires the packaging fix, without which any further rc is equally hollow (as rc.7's hotfix already demonstrated, invisibly). The genuinely new source changes for rc.9 are small (cwd sandbox, two grounding lines, `.bak` cleanup). "Tier B in parallel" also holds, but its priority argument needs adjusting: as designed it would **not** have caught this incident; the parallel Tier B work should include pointing it (or a release smoke) at the packaged artifact and actually turning it on in CI, otherwise it only protects the path that was never broken.
