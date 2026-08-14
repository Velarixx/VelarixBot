# rc.12 analysis: `hermesAgent exited 2`, silent Codex, and the "DONE but empty" turn

Analysis only — no application code was changed. Everything below was read from, or executed
against, tag `v0.2.0-rc.12` (`3a52035`), tag `v0.2.0-rc.11` (`2786aeb`), and the shipped rc.12
Windows installer (checksum-verified). Line numbers refer to the rc.12 tag.

**Revision 2** — updated after Dyon's second report: restart + a brand-new Codex bot, green
**DONE** badge, Electron **"Finished"** toast, **0 tokens · cost unavailable**, user messages in
the transcript, no assistant replies. That evidence *refutes* the earlier stuck-busy-renderer
lead as the operative mechanism and pins the silence on two reproduced server-side defects.

## TL;DR verdict — three defects, one story

1. **Hermes exit 2 (confirmed, reproduced):** the driver spawns
   `hermes --approval-policy acp|never [-m <model>] acp stdio`
   (`server/drivers/acp/hermes.ts:41-47`); the installed `hermes` binary rejects that argv,
   prints its own usage/subcommand list to stderr, and exits 2 before ever speaking ACP. The
   "plugin list" in the chat message is the CLI's own subcommand catalog, double-truncated
   (`stderr.slice(-300)` at `acp/core.ts:396`, then a 160-char display cap at
   `services/turns.ts:658` — the observed string lands on exactly 160 chars). The grammar was
   never validated against a real Hermes CLI anywhere (see Tests).
2. **Codex "DONE but empty" (confirmed, reproduced — explains the new screenshot exactly):**
   the codex driver treats **any exit 0 before a `turn/completed` notification as a successful
   turn** (`server/drivers/codex.ts:520-529`: `if (code === 0) { settle(true, null); return; }`).
   If the `codex` binary on PATH doesn't actually speak the app-server protocol (outdated or
   shadowed CLI — the exact pattern of
   [issue #9](https://github.com/Velarixx/VelarixBot/issues/9), which was closed by the user
   updating their CLI, with **no code fix**), every turn completes `ok:true` with **no assistant
   text, no error chip, and no token usage**. Reproduced live: SSE shows
   `turn.started → turn.completed ok:true` with nothing in between; bot state `DONE`, usage
   `{input:0, output:0}`. That is the green DONE badge, the "Finished" toast, "0 tokens · cost
   unavailable", and the missing bubble — all four pixels of the screenshot from one line of
   code.
3. **Server-process death on a fast-exiting CLI (confirmed, reproduced — the "dead session"):**
   drivers write to `child.stdin` with only a synchronous try/catch and **no `error` listener on
   the stream** (`codex.ts:239-244`, same pattern `acp/core.ts:190-195`). When the CLI exits
   before the write is dispatched, Node emits an asynchronous `write EPIPE` as an unhandled
   `'error'` event and **the whole server process dies** — reproduced with this exact stack:

   ```
   Error: write EPIPE
       at send (server/drivers/codex.ts:241)
   Emitted 'error' event on Socket instance … node:events: throw er; // Unhandled 'error' event
   ```

   Electron main never supervises the forked server after boot (`electron/main.mjs:39-55` — the
   exit listener only matters during startup; no respawn, no notice), so the app window stays up
   while every bot and provider is dead until relaunch. This — not a renderer wedge — is the
   best-supported mechanism for the *original* "Hermes errored once, then nothing responds, and
   Codex is dead too" report: whether a given turn produces the visible error (hermes exit 2), a
   silent empty DONE (codex exit 0), or kills the server outright (EPIPE) is a per-spawn race on
   the same underlying condition, a CLI that exits within milliseconds.

Unifying environmental note: both symptoms need a broken CLI on PATH, and Dyon hit both right
after trying Hermes. Issue #9's own diagnostics show the Hermes product ships its own toolchain
(`/Users/ridvan/.hermes/node/bin/codex` 0.147.0 vs a stale `/opt/homebrew/bin/codex` 0.136.0) —
installing/uninstalling Hermes is exactly the kind of PATH change that can put a non-app-server
`codex` first. VelarixBot resolves bare names in PATH order by design
(`server/drivers/cli.ts:76-81` "PATH shadowing is intentional") and `snapshot()` only runs
`--version` (`codex.ts:596-601`), so a guaranteed-to-fail binary still shows "available".

The renderer stuck-busy wedge described in revision 1 remains a real design hazard (details kept
below) but is **demoted**: the new evidence (DONE badge — not busy; user bubbles rendering — SSE
alive and POSTs accepted) rules it out for this repro, and defects 2+3 explain the earlier
report without it.

---

## Round 2: mapping every element of the screenshot to code

| Screenshot element | Source |
|---|---|
| Model dropdown "GPT-5.6 Sol" on a Codex bot | Codex's default model is `gpt-5.6-sol` (`server/drivers/codex-models.ts:17`, fallback catalog `:39`). It is also Hermes's default (`acp/hermes.ts:28`), but a bot "created with Codex from the start" showing GPT-5.6 Sol is simply the Codex default — no Hermes involvement. |
| "Hey — I'm your new bot. Nice to meet you." | **Local seed**, appended at bot creation (`server/services/bots.ts:87-93` area, `appendMessage(... "Hey — I'm your new bot. Nice to meet you.")`). Not a model turn. |
| "What do you mostly want help with?" card with Work & projects / Writing & research / Life admin / A bit of everything | **Local first-run card**: `onboardingCard()` in `server/store.ts` carries exactly those four options. It is seeded for every new bot regardless of provider — it is *not* `velarix_options`/response-options output and is not gated per driver (the response-options gate applies to model-emitted option text, `services/turns.ts:567-568`). Its presence on a Codex bot is expected. |
| Clicking "Work & projects" | The card has no `requestId`, so the renderer POSTs the label as a normal message (`src/state/store.tsx:679-685`) — a plain user turn. |
| Green **DONE** badge | `turn.completed` with `ok:true` folds to `state: "DONE"` (`services/turns.ts:685`); rendered via `stateLabel` (`src/lib/product.ts:9-10`). |
| Electron toast "New Bot — Finished" | The renderer's SSE fold calls `window.ogb.notify` on `turn.completed` (`src/state/store.tsx:888-895`); the copy is `event.ok && !blocked ? "Finished" : "Didn't finish"` (`src/lib/notify.ts:38-46`). So the toast fires on **any ok-completed turn, including an empty zero-token one**. |
| "0 tokens · cost unavailable" | Usage comes only from `thread.token-usage.updated` events; when none arrived, the fold records `{input:0, output:0, cost:null}` (`services/turns.ts:669-670`). An empty settle emits no usage event. |
| User messages visible, no replies, no error chips | Turns completed `ok:true` ⇒ no `runtime.error`, no `error:` activity chip, and no `item.completed assistant_text` ⇒ nothing to render. Server accepted every POST (busy cleared after each DONE). |

## The exact empty-turn mechanism (reproduced)

`server/drivers/codex.ts:520-536`:

```
child.on("close", (code) => {
  flushStdout();
  if (state.settled) return;
  // Codex sometimes exits 0 without a turn/completed notification … That is
  // a clean end, not a killed turn — only a non-zero close is failure.
  if (code === 0) {
    settle(true, null);
    return;
  }
  emit({ …, type: "runtime.error", message: `codex exited ${code} before turn/completed…` });
  settle(false, "exit_before_result");
});
```

`settle(true, null)` emits only `turn.completed ok:true` (`codex.ts:254-263`) — no text item, no
usage. This rule predates rc.12 (introduced in `29e3bf3`, the rc.4-era "create_bot MCP" commit)
— it is a **latent hole, not an rc.12 regression**: it converts any `codex` binary that exits 0
without speaking the app-server protocol (old CLI treating `app-server` as a prompt, a wrapper,
a not-logged-in fast path) into an endless sequence of invisible "successful" empty turns.

Live reproduction on the rc.12 tag (fake `codex` that prints two plain-text lines and exits 0
after ~600 ms): three messages ("Work & projects", "still not responding", "hello?") each
produced the SSE sequence `message(user) → bot busy:true → turn.started → turn.completed
ok:true → bot busy:false state:DONE`, final bot state
`{busy: false, state: DONE, usage: {input: 0, output: 0}}`, transcript containing only the
seeded greeting, the seeded onboarding card, and the three user messages. Identical to the
screenshot, including the "Finished" toast trigger.

Why this also fits "Codex after switching back" in the first report: the same binary produced
the same silent empty DONEs there; the visible difference from Hermes (loud exit-2 chips) is
only the exit code — codex.ts maps 0 to success while the hermes/ACP core maps *any* pre-result
exit to a visible `runtime.error` (`acp/core.ts:391-399`).

## The server-death mechanism (reproduced)

With the same fake exiting 0 in ~10 ms instead of 600 ms, the very first turn killed the entire
server: the `initialize` write raced the child's exit, Node emitted an async `write EPIPE` on
`child.stdin` — which has **no `error` listener** — and the process died with an unhandled
`'error'` event (stack at `codex.ts:241`, invoked from `request()` at `:249`). The `try/catch`
in `send()` (`codex.ts:239-244`) covers only the synchronous call; `acp/core.ts:190-195`
(hermes/grok/gemini) has the identical exposure with an equally fast-dying CLI (Dyon's hermes
exits within milliseconds of spawn).

Post-crash artifacts (what to look for on Dyon's machine, question 7):

- `~/.velarixbot/native/<threadId>.ndjson`: only `dir:"out"` lines (the `initialize` request),
  zero `dir:"in"` lines — the CLI never spoke JSON. (In the empty-DONE case: same, because
  non-JSON stdout lines are discarded before logging, `codex.ts:475-482`.)
- `~/.velarixbot/events/<threadId>.ndjson`: ends at `turn.started` with no `turn.completed`
  (crash case) vs `turn.started` + `turn.completed ok:true` pairs with nothing between
  (empty-DONE case).
- SQLite bot row persisted `busy:true, state:RUNNING` mid-turn (crash case). On the next boot
  `recoverInterrupted` flips crashed RUNNING/busy records back to idle
  (`server/store.ts:82-95`, invoked from the composition root `server/app.ts`), which is why a
  restart lets the same profile accept turns again — matching Dyon's restart behavior.
- Electron main: `utilityProcess` exit is only observed during startup
  (`electron/main.mjs:52-55`); after boot a dead server means every POST fails (transient 6 s
  banner, `src/state/store.tsx:599-624`), typed messages vanish, SSE never reconnects to
  anything — total silence across all bots/providers until app relaunch.

Which face Dyon saw when: in the round-2 screenshot the server was alive (user bubbles rendered,
DONE badges updated) — that is the empty-DONE loop. In the round-1 report ("Hermes errored once,
then nothing at all, Codex dead too"), either the EPIPE crash killed the server after the first
visible hermes error, or the same empty-DONE loop ran on Codex; both are the same two defects.

## Round-1 findings that still stand (condensed)

- **Hermes argv:** no plugins/skills argument is passed; the list in the error is the CLI's own
  usage output. Character math: 47-char prefix + 113-char stderr tail = exactly the 160-char cap
  (`turns.ts:658`), with `slice(-300)` (`core.ts:396`) having cut mid-"orchest**rator**".
  "The prompt result" is the ACP `session/prompt` JSON-RPC response (`core.ts:8-9`, `462-478`);
  exit 2 is the CLI's own usage-error status, relayed — the process died parsing argv, before
  `initialize`.
- **Server-side turn/lock/provider-switch handling is sound** (verified live in four flows,
  including rapid-fire queueing and an rc.11→rc.12 upgraded profile): `busy` clears on both
  `runtime.error` and `turn.completed` (`turns.ts:656-698`), the ACP `active` map clears in
  `settle` (`core.ts:213-229`), resume cursors are per-instance (`turns.ts:882`) and a Hermes
  session id is never handed to Codex; codex falls back `thread/resume` → `thread/start`
  (`codex.ts:546-580`).
- **Packaging ruled out:** the installer was built from the tag SHA; unpacked server and P1.3
  renderer match the tag source; checksums verified. Current source, not a stale binary.
- **rc.10 MCP elicitation bug (`{decision}` vs `{action}`) is fixed in rc.12**:
  `elicitationReply` returns `{action: "accept"|"decline"}` (`codex.ts:165-168`), replies are
  routed per method (`codex.ts:322-331`), unknown methods get JSON-RPC -32601
  (`codex.ts:278-289`). Irrelevant to this repro regardless: a plain "hello?" / onboarding-card
  answer invokes no MCP tool, no approval card appeared, and the empty turn shows the CLI never
  even started a thread.
- **Renderer stuck-busy hazard (demoted, still real):** `busy:true` is set optimistically on
  send (`store.tsx:536-542`) and cleared only by SSE; while busy, sends are silently enqueued
  and never POSTed (`store.tsx:626-644`); `setModel` clears nothing (`store.tsx:427-428`,
  `745-749`); `resync()` is not single-flighted and can lose buffered frames / set the cursor
  backward (`store.tsx:806-826`). Not the mechanism in either report (round 2 shows DONE, not
  busy), but it converts any missed `busy:false` into a permanent, provider-independent, silent
  wedge and should still be fixed.
- **Tests:** Tier A (`ci.yml` → `pnpm test`) pins driver argv against accept-anything fakes
  (`hermes.test.ts:119-133`; codex tests use `fake-codex-app-server.ts`) — it cannot falsify a
  CLI grammar or a real binary's behavior. Tier B (`eval.yml`) has a real-Hermes leg that has
  **never run** (`HERMES_AUTH_JSON: absent` in every run) and the eval runs were all failing
  anyway; the protocol canary covers Codex protocol drift only, and no tier covers "CLI on PATH
  is not the CLI we think it is" or "turn completes ok with zero output". Neither round-1 nor
  round-2 behavior could have been caught.

## Answers to the round-2 questions

1. **GPT-5.6 Sol** → Codex's default model (`server/drivers/codex-models.ts:17`, `:39`); also
   Hermes's default (`acp/hermes.ts:28`). On a bot created with Codex it is Codex.
2. **DONE badge** = `turn.completed ok:true` → `state:"DONE"` (`services/turns.ts:685`) →
   `stateLabel` (`src/lib/product.ts:9-10`). **"Finished" toast** = renderer SSE fold →
   `notifyCopy` → `window.ogb.notify` (`src/state/store.tsx:888-895`, `src/lib/notify.ts:38-46`).
   Both fire on an empty zero-token turn — nothing in either path requires output.
3. **0 tokens + no message**: `settle(true, null)` from the exit-0 rule (`codex.ts:520-529`)
   emits only `turn.completed`; no `item/completed agentMessage` ⇒ no assistant bubble
   (`turns.ts:563-569`), no `thread/tokenUsage/updated` ⇒ usage defaults to zero
   (`turns.ts:669-670`). Not an SSE folding problem — reproduced with the full frame trace.
4. **Greeting and onboarding card are local seeds** (`server/services/bots.ts`,
   `server/store.ts onboardingCard()`), provider-independent by design; not
   `velarix_options` leakage (that gate concerns model-emitted text only).
5. **Restart/new bot**: persisted `busy` cannot wedge a new bot, and crashed RUNNING/busy
   records are recovered at boot (`server/store.ts:82-95` via `server/app.ts`); the renderer
   starts from a fresh snapshot. Round 2 is therefore **not** a renderer/SSE wedge — it is the
   empty-completion defect, which also retro-explains the round-1 "Codex after switch" silence.
6. **Elicitation**: fixed in rc.12 (`{action}` shape, per-method routing) and not exercised by
   this repro (no MCP call in "hello?"; no approval card in the screenshot; the CLI never
   reached a thread).
7. **Logs for this screenshot**: native ndjson with outbound `initialize` (+
   `thread/start`/`turn/start` if the CLI lived long enough) and **no inbound** lines; events
   ndjson with bare `turn.started`/`turn.completed ok:true` pairs; SQLite messages containing
   only seeds + user rows. In the crash variant, events end at `turn.started` and the bot row is
   left `busy:true` until boot recovery.

## Must-fix vs nice-to-have

Must-fix:

1. **Stop mapping exit-0-without-`turn/completed` to success** (`codex.ts:520-529`). An exit
   before the prompt/turn result with zero protocol traffic (no `initialize` response — the
   driver can already tell from `rpcPending`) is a failure with the stderr/stdout tail surfaced,
   whatever the exit code. Keep the historical "clean exit 0 after output" tolerance only when
   at least one protocol message was received.
2. **Attach `error` listeners to driver child stdin** (`codex.ts` `send`, `acp/core.ts` `send`)
   and add last-resort `uncaughtException`/`unhandledRejection` logging in `server/index.ts`;
   **supervise the server `utilityProcess`** in `electron/main.mjs` after boot (respawn and/or a
   visible "bot server stopped" surface). A misbehaving third-party CLI must never take the app
   down silently.
3. **Validate the Hermes spawn grammar against a real CLI** and fix
   `acp/hermes.ts:41-47` accordingly; keep the approval pin only if the CLI supports it.
4. **Preflight CLI identity, not just presence**: `snapshot()`'s `--version` probe
   (`codex.ts:596-601`, `acp/core.ts:494-499`) should verify the binary actually speaks the
   expected protocol (cheap handshake or capability scrape) and surface the resolved path +
   version, so a PATH-shadowed/outdated `codex` or a wrong `hermes` shows as "unusable: <path>
   <version> does not support app-server/ACP" instead of "available". This is the code fix
   issue #9 asked for and never got.

Nice-to-have:

5. Fix the renderer stuck-busy hazards anyway: single-flight `resync()`, reconcile `busy` with
   the server on reconnect/focus, visible queue feedback, reconcile on `setModel`.
6. Keep the full `runtime.error` text (head of stderr included) in `stateDetail`/tooltip instead
   of the double truncation; the actual `error: unknown option …` line never reached Dyon.
7. Extend driver-contract fixtures with "CLI exits 0/2 with no protocol traffic" cases asserting
   both the user-facing message and that the turn is **not** reported ok; add a Hermes protocol
   canary mirroring `protocol-canary.yml`; configure `HERMES_AUTH_JSON`; make `eval.yml` green
   so optional legs mean something.
8. Consider notifying "Didn't finish" (or suppressing "Finished") when an ok turn produced zero
   items and zero tokens — an honest toast for a hollow turn.
