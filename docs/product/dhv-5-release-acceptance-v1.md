# DHV-5 release acceptance matrix v1.0

- Version: 1.0
- Evidence date: 2026-08-18
- Scope: the repository's current local primary workflow and explicit failure
  states; this is not a production-readiness declaration.
- Sources: `docs/product/dhv-5-baseline.md`,
  `docs/architecture/0001-explicit-ui-connection-state.md`, the fake harness,
  focused smoke evidence below, and the named repository tests.

## Status and severity

`Covered` means the named evidence exercises the expected contract. `Partial`
means some layers are covered but a release-significant boundary is not.
`Uncovered` has no adequate evidence. `Deferred` is deliberately outside DHV-8.

Severity is provisional release guidance for the Chief of Staff: `Blocker` must
pass for any release in scope, `High` requires explicit acceptance if it remains
open, `Medium` should be scheduled, and `None` is outside this release decision.

## Matrix

| Critical journey / state / risk | Acceptance expectation | Evidence | Status | Owner | Release-blocking severity |
| --- | --- | --- | --- | --- | --- |
| Clean local start and onboarding | A clean browser profile reaches onboarding, finds the configured local engine, and enters the app without an account or external call. | `e2e/fake-engine-smoke.spec.ts`: clean context + throwaway harness home; visible `fake-claude 1.0.0` assertion. | Covered | Test/Release Engineer | Blocker |
| Create a bot from the primary UI | The user can name/configure a bot and reaches its composer with the bot visible. | Focused smoke creates `Smoke Agent` through the modal and waits for `Message Smoke Agent`. | Covered | Test/Release Engineer | Blocker |
| Send and receive one turn | A submitted prompt is visibly rendered; the selected engine streams/completes a visible response; subagent noise is not shown. | Focused smoke uses `server/testing/fake-claude-cli.ts` in `stream` mode and asserts the prompt, `hello from fake claude`, and absence of `SUBAGENT NOISE`. | Covered | Test/Release Engineer | Blocker |
| Connection-loss feedback and draft preservation | After a previously connected stream reports an error, a persistent reconnecting notice is visible, Enter does not dispatch, and the local draft remains. | Focused smoke delegates to the real harness EventSource and deterministically emits its `error` lifecycle event; visible banner, zero rendered prompt, and retained input value are asserted. `src/components/ConnectionExperience.test.ts` and `src/state/store.test.ts` provide component/state evidence. | Covered | Test/Release Engineer | Blocker |
| Recovered connection and delayed send | After the stream reports recovery, the notice clears, the preserved draft remains, and it can then be sent successfully. | Focused smoke emits the EventSource `open` lifecycle event, asserts the banner clears and draft remains, then completes the fake-engine turn. | Covered | Test/Release Engineer | Blocker |
| Real socket drop and SSE replay | A transport-level disconnect reconnects without lost or duplicated persisted frames. | `server/sse-resume.test.ts` covers forced disconnect, cursor replay, dedupe, and snapshot folding at server/API level. The browser smoke controls lifecycle events rather than timing a real socket failure. | Partial | Founding Engineer + Test/Release Engineer | High |
| Reload/restart hydration | A created bot and completed transcript survive renderer reload and server/app restart with the right selected state. | `server/sse-resume.test.ts` covers snapshot/replay mechanics. No deterministic browser reload plus process-restart journey is included in this smoke. | Partial | Founding Engineer + Test/Release Engineer | High |
| Approval request, allow, and deny | A risky tool request is visible; allow/deny works once; persistence scope is explicit and safe. | `server/approvals.test.ts` covers rule safety and persistence; `eval/flow.mjs` has browser selectors but requires live provider credentials. No secret-free deterministic browser approval journey is evidenced here. | Partial | Founding Engineer + Test/Release Engineer | High |
| Provider unavailable / turn failure | The user gets a concrete, actionable failure and can choose a valid recovery without silent failover. | `server/engine-unavailable-turns.test.ts` covers fake-driver service behavior. No visible browser assertion is in the focused smoke. | Partial | Founding Engineer | High |
| Launch-token protection | API and SSE are inaccessible without the per-launch token and the desktop shell injects it only for the local server origin. | `server/auth.test.ts`, `electron/api-auth.test.ts`; focused smoke uses a unique harness token in browser headers. Packaged Electron injection is not exercised by this browser smoke. | Partial | Founding Engineer | High |
| Backup and restore | A verified backup restores into an empty profile without secrets leaking or user data silently disappearing. | `server/db/backup.test.ts` covers verified archive/restore into isolated profiles. No packaged desktop/manual restore evidence is attached to DHV-8. | Partial | Founding Engineer + Test/Release Engineer | High |
| Windows packaged app | Install/launch, onboarding, primary turn, reconnect behavior, and cleanup work in the unsigned internal Windows package. | `.github/workflows/release.yml` builds/checks the package; this run used headless Chromium on Windows, not the packaged Electron app. | Uncovered | Test/Release Engineer | High |
| macOS packaged app | Install/launch, permissions, primary turn, reconnect behavior, and cleanup work in the macOS package. | Release workflow contains package checks; no macOS run is attached to DHV-8. | Uncovered | Test/Release Engineer | High |
| Production-provider compatibility | At least one supported real provider completes the primary path without exposing credentials. | Explicitly excluded from this deterministic smoke. The credentialed scheduled eval is separate and report-only in parts. | Uncovered | Founding Engineer + Test/Release Engineer | High |
| Navigation/hierarchy cases | Selected navigation preserves the primary workflow and state transitions. | Deferred until the CEO selects a DHV-7 proposal and the Founding Engineer integrates a thin slice. | Deferred | CEO + Founding Engineer | None for DHV-8 |
| Cross-browser matrix | Browser-engine-specific behavior is characterized. | Deliberately deferred; Chromium is the only configured zero-cost smoke target. | Deferred | Test/Release Engineer | None for DHV-8 |

## Focused evidence

Environment observed in this workspace:

- Windows PowerShell
- Node `v22.20.0` (below the repository-declared `>=24`; see residual risks)
- pnpm `10.33.0` through Corepack
- Playwright `1.62.1`, Chromium revision `1234`
- No production credentials, services, customer data, or mutable external state

Setup used:

```text
corepack pnpm --version
node node_modules/playwright/cli.js install chromium
```

Static check:

```text
corepack pnpm typecheck:smoke
> tsc -p tsconfig.e2e.json
Exit code: 0
```

Repeatability runs, each from a newly created harness home and browser context:

```text
corepack pnpm test:smoke
> vite build && playwright test e2e/fake-engine-smoke.spec.ts --workers=1 --reporter=line
Run 1: build passed (2339 modules); 1 passed (2.4s); exit code 0

corepack pnpm test:smoke
> vite build && playwright test e2e/fake-engine-smoke.spec.ts --workers=1 --reporter=line
Run 2: build passed (2339 modules); 1 passed (2.3s); exit code 0
```

The test has no fixed sleeps. Setup waits for the harness health endpoint; the
journey waits on visible roles, placeholders, values, and rendered messages.
Teardown closes the browser context, SSE recorder, server process tree, and
best-effort removes the unique temporary home.

## Stabilization findings and residual risks

- The harness deterministically seeds a `Chief of Staff` starter bot; the smoke
  records that as its known start state rather than assuming an empty product.
- Chromium offline emulation did not close an already-open EventSource. The
  smoke therefore wraps the real EventSource and deterministically emits the
  same `error`/`open` events consumed by the UI. Actual browser socket teardown
  remains the explicit partial-coverage item above.
- The first sandboxed build attempt failed with esbuild `Access is denied` while
  resolving `vite.config.ts`; the focused command passed when allowed to launch
  the local build, server, and browser processes.
- Both evidence runs passed on Node 22 but emitted the expected unsupported-engine
  warning. Release evidence still needs one Node 24 run, matching `package.json`
  and CI, before the runtime can be treated as supported.
- The smoke is Chromium-only and uses the scripted fake engine. It proves the
  bounded UI/harness contract, not packaged desktop or production-provider
  readiness.

## Recommended follow-ups

1. Founding Engineer: provide or confirm a narrow, non-production harness seam
   for a real browser SSE disconnect/reconnect so the lifecycle adapter can be
   replaced by transport-level evidence.
2. Founding Engineer and Test/Release Engineer: add restart hydration and a
   secret-free approval card scenario as separate thin slices; do not broaden
   this smoke into a general E2E platform.
3. Test/Release Engineer: rerun `typecheck:smoke` and `test:smoke` on Node 24 and
   attach the result to the release candidate.
4. Chief of Staff: confirm whether the provisional `High` gaps above block the
   next internal release or receive explicit, time-bounded acceptance.
