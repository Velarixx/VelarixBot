# DHV-71 Vitest skip inventory

## Verdict

**CHANGES REQUIRED / NOT RELEASE-ACCEPTED.** The exact baseline contains 95 enumerated skips. All 95 have a file, full test name, condition, reason, owner, classification, and validity disposition in the adjacent `dhv-71-vitest-skip-ledger/` artifact. The inventory verifier passes against the exact-SHA report and its negative control fails on a synthetic new skip. Release acceptance remains blocked by baseline test failures, the missing live-Gemini prerequisite, unsuccessful remediation-issue creation, and independent QA/Test Lead review.

No production file, skipped assertion, DHV-54 workflow file, or CI workflow was changed for DHV-71. CI integration is intentionally deferred until QA/Test Lead exact-SHA approval.

## Exact baseline and environment

- Repository SHA: `46e9963774a45f90c1414b93a8ce4a6b57ca12e8`
- Git tree: `e0142653da88ad44409ffd0bba29c8a698b89f5b`
- Runtime: `Node v24.19.0` via `npx -y node@24`
- Rejected default runtime: `Node v22.20.0` (below repository and release-gate minimum)
- OS: Windows, `process.platform === "win32"`, x64
- Vitest: `4.1.10`
- Gemini: absent from `PATH` (`where gemini` non-zero as evaluated by the tests/verifier)
- Isolation: exact SHA was exported with `git archive --format=zip`, expanded under `PAPERCLIP_RUN_SCRATCH_DIR`, and linked read-only to the workspace's already-installed `node_modules`. The source tree and tree hash were exact; this was not a fresh frozen install, so dependency-install integrity remains parent DHV-50 evidence, not evidence established here.
- Shared-worktree warning: DHV-50 and other runs mutated and committed concurrently during this work. Shared HEAD moved from `941d9db0ef27f812246264cd43bba19d643dc75f` to `272863088f37974a706b495775a4a0b310e1dd40` while skipped-test files were dirty. Those shared-tree runs are diagnostic only.

## Ledger summary

| Classification | Count | Validity | Condition | Owner / action |
| --- | ---: | --- | --- | --- |
| Valid platform N/A | 88 | Valid on Windows | `process.platform === "win32"` | Founding Engineer — Windows test-harness portability |
| Valid capability N/A | 4 | Valid protocol N/A | Fixture `question.unsupported` or `drift.unsupported` contains a reason | Founding Engineer — provider-driver contract |
| Missing dependency | 3 | Invalid release-evidence gap | `hasGeminiCli === false` | QA/Test Lead prerequisite; one non-overlapping Founding Engineer remediation issue required |
| Mock-only gap | 0 | None observed as a skip | N/A | N/A |
| Unjustified skip | 0 | None observed | N/A | N/A |

The 88 platform rows are distributed across mode-bit, nvm/chmod/shebang, and fake-CLI process tests. The repository's `CONTRIBUTING.md` explicitly permits the shebang guard on Windows until Windows CLI spawning lands. The four capability rows are generated only from explicit non-empty unsupported reasons in the driver-contract fixtures. The three live-Gemini rows are backed by hermetic fake tests but do not supply live-binary release evidence.

Per-source counts are enforced by `manifest.json`: 1 service-auth, 1 config, 1 database, 17 ACP, 3 live Gemini, 25 Claude, 40 Codex, 4 driver contract, 2 env-path, and 1 secrets test.

## Deterministic commands and observed output

Fresh gate for a checkout containing this verifier:

```powershell
npx -y node@24 scripts/verify-vitest-skip-inventory.mjs
```

The command enforces Node >=24, launches the repository Vitest binary, collects JSON, validates every ledger field and manifest count, computes platform/dependency applicability, and compares skipped tests as a multiset. It fails for a new/unreasoned skip, a stale ledger row, a malformed/incomplete rationale, or any non-zero Vitest run. It does not alter tests or CI.

Report-only reconciliation used for the exact-SHA artifact:

```powershell
npx -y node@24 scripts/verify-vitest-skip-inventory.mjs --report "$env:PAPERCLIP_RUN_SCRATCH_DIR\vitest-46e9963-node24.json"
```

Observed exit `0`:

```text
Vitest skip inventory: runtime=v24.19.0 platform=win32 gemini=absent expected=95 observed=95
Classes: platform=88, capability=4, missing_dependency=3, mock_only_gap=0, unjustified=0
PASS: report skip inventory exactly matches its reasoned ledger.
```

Negative control:

```powershell
npx -y node@24 scripts/verify-vitest-skip-inventory.mjs --report "$env:PAPERCLIP_RUN_SCRATCH_DIR\vitest-46e9963-node24.json" --negative-control
```

Observed expected exit `1`, with `expected=95 observed=96`, report-count mismatch, and:

```text
FAIL: new or unreasoned skips:
  + negative-control.test.ts :: DHV-71 synthetic unreasoned skip
```

Exact-SHA Vitest collection command:

```powershell
npx -y node@24 node_modules/vitest/vitest.mjs run --reporter=json --outputFile="$env:PAPERCLIP_RUN_SCRATCH_DIR\vitest-46e9963-node24.json"
```

Observed exit `1`: 447 suites total, 434 passed, 13 failed; 1,362 tests total, 1,261 passed, 6 failed, 95 skipped. Failing assertions were:

- `electron/cua-connection.test.ts` — darwin CUA connection unchanged
- `electron/service-control.test.ts` — Aqua LaunchAgent rendering
- `server/secret-scan.test.ts` — tracked-tree secret scan
- `server/suggestions.test.ts` — P0.1 Allow copy/persist rules
- `server/services/shared-computer-lease.test.ts` — loud busy timeout
- `server/drivers/acp/gemini.test.ts` — closed-child-stdin/EPIPE settlement

`server/drivers/driver-contract.test.ts` also reported an `EPERM` cleanup suite failure. Every failure remains blocking; none was skipped, rewritten, or relabeled.

The fresh wrapper run against the later concurrent dirty worktree exited `1`. It observed only 78 skips because all 17 `server/drivers/acp/acp.test.ts` ledgered rows were absent from that run, and Vitest itself exited non-zero. The wrapper correctly reported every stale row and preserved the Vitest failure as a gate failure.

## Remediation and review state

Exactly one invalid class exists: the three `missing_dependency` live-Gemini canaries. Two attempts to create its single non-overlapping child issue failed through the Paperclip control plane: first `Internal server error`, then `API route not found`. The heartbeat contract prohibits further retries in this run. The required issue must be owned by the Founding Engineer and limited to providing a reproducible Node >=24 environment with the repository-supported Gemini executable; it must not edit or weaken the tests, use paid spend/production credentials, or overlap Windows harness/capability work.

Independent QA/Test Lead review is still required for the final DHV-71 commit SHA. Until that review is recorded and required GitHub CI for the same SHA succeeds, this work must not be integrated into CI, approved for release, pushed, or treated as a green baseline.
