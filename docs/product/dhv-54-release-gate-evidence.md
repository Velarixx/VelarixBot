# DHV-54 implementation evidence

Evidence date: 2026-08-19

Pre-edit parent HEAD: 941d9db0ef27f812246264cd43bba19d643dc75f

Environment:

- Windows PowerShell, Europe/Amsterdam
- Local default Node v22.20.0 (unsupported and not used for acceptance checks)
- Supported fallback Node v24.19.0 through npx -y node@24
- pnpm 10.33.0 from the Corepack cache, executed by Node 24
- Playwright 1.62.1 with the installed pinned Chromium
- Shared workspace with concurrent unrelated production/test edits; those
  edits are excluded from the DHV-54 commit.

## Passing focused evidence

    npx -y node@24 --version
    v24.19.0
    exit 0

    npx -y node@24 <pnpm-10.33.0-cli> --version
    10.33.0
    exit 0

    CI=true npx -y node@24 <pnpm-10.33.0-cli> install --frozen-lockfile
    lockfile up to date; 496 packages reused; exit 0

    npx -y node@24 <pnpm-10.33.0-cli> verify:release-gate
    exact-SHA validation passed on v24.19.0; exit 0

    npx -y node@24 <pnpm-10.33.0-cli> verify:lint-format
    10 scoped gate files passed; exit 0

    npx -y node@24 <pnpm-10.33.0-cli> verify:inventories
    3 files passed; 16 tests passed; exit 0

    npx -y node@24 <pnpm-10.33.0-cli> typecheck
    client and server TypeScript passed; exit 0

    npx -y node@24 <pnpm-10.33.0-cli> typecheck:smoke
    E2E and release Playwright config TypeScript passed; exit 0

    npx -y node@24 <pnpm-10.33.0-cli> exec vitest run server/release-config.test.ts
    1 file passed; 5 tests passed; exit 0

    npx -y node@24 <pnpm-10.33.0-cli> build
    client/server TypeScript passed; Vite built 2348 modules; exit 0

    npx -y node@24 <pnpm-10.33.0-cli> test:e2e
    6 deterministic Playwright tests passed in 29.7s; exit 0

    npx -y node@24 scripts/secret-scan.mjs
    488 tracked files clean; exit 0

    npx -y node@24 <pnpm-10.33.0-cli> audit --audit-level=high
    no known vulnerabilities; exit 0

The first frozen-install invocation, without CI=true, exited 1 with
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY before dependency resolution.
CI=true is the required non-interactive environment assumption when pnpm must
refresh node_modules.

The first two attempts to run both E2E specs without a dedicated Playwright
testDir exited 1 because Playwright discovered another agent's untracked
.paperclip-audits checkout and loaded its second Playwright copy. The dedicated
playwright.release.config.ts now confines discovery to the tracked e2e
directory and explicitly names both applicable specs. The complete isolated
run passed 6/6.

## Blocking full-suite evidence

Final working-tree command:

    npx -y node@24 <pnpm-10.33.0-cli> test

Result: exit 1 after 142.49s; 150 test files passed, 5 failed; 1275 tests
passed, 6 failed, and 95 skipped out of 1376.

Observed blockers:

- server/drivers/driver-contract.test.ts: suite cleanup EPERM on the isolated
  Windows temporary home.
- server/services/shared-computer-lease.test.ts: Windows temporary-profile
  cleanup EPERM.
- server/drivers/acp/gemini.test.ts: closed-stdin result was
  exit_before_result rather than stdin_error.
- server/suggestions.test.ts: approval source-contract assertion failed while
  concurrent OptionCard implementation edits were present.
- src/components/OptionCard.test.ts: three source-contract assertions failed
  while concurrent OptionCard implementation edits changed during this run.

No failure was skipped, quarantined, deleted, or weakened. DHV-54 cannot be
accepted while this evidence is red. The Founding Engineer owns reconciliation
of implementation/test conflicts; the QA/Test Lead must rerun the full gate on
the exact committed SHA in an isolated or stable checkout.

The 95 skips were emitted by the existing suite. The known declarations include
documented POSIX-only tests on Windows and an optional live Gemini CLI suite.
They are not approved by this implementing agent; the QA/Test Lead must inspect
and disposition every skip for the exact candidate.

## External enforcement blockers

The GitHub audit found main unprotected, no repository rulesets, and no check
runs on the then-current origin/main. Repository code cannot change or verify
those settings. The Chief of Staff, acting as repository administrator, must
perform the exact action in docs/product/exact-sha-release-gate.md.

Two attempts to create the required critical blocked child issue through the
Paperclip API did not succeed: the first used an unavailable route, and the
second was rejected as a delegation cycle when assigned to the Chief of Staff.
Per the heartbeat control-plane retry limit, creation was not retried again in
this run. This must be created unassigned or by a board operator on continuation.

No GitHub CI URL exists for the local candidate because this batch was not
pushed. No exact-SHA approval, push result, or origin/main equality is claimed.
