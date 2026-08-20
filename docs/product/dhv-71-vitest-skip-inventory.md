# DHV-71 Vitest skip inventory

## Verdict

**CHANGES REQUIRED / NOT RELEASE-ACCEPTED.** The corrected exact-parent baseline contains 78 enumerated skips. All 78 have a file, full test name, condition, reason, reporting owner, classification, and required boolean validity disposition in the adjacent `dhv-71-vitest-skip-ledger/` artifact. The three invalid rows additionally name a distinct remediation owner and durable remediation issue. The inventory verifier passes against the exact-parent report and its negative control fails on a synthetic new skip. Release acceptance remains blocked by the non-green Vitest run, the missing live-Gemini prerequisite tracked by DHV-100, required GitHub CI, and fresh independent QA/Test Lead exact-SHA review.

No production file, skipped assertion, DHV-54 workflow file, or CI workflow was changed for DHV-71. CI integration is intentionally deferred until QA/Test Lead exact-SHA approval.

## Exact baseline and environment

- Evidence parent SHA: `f73fd89b28458619710289dbf3a2257c2ba208e3`
- Evidence parent tree: `60976dfa591958d79f9ed08439805ebb893cd018`
- Corrective relationship: the DHV-101 commit is a QA-artifact-only child of the evidence parent above. Its exact SHA and `HEAD^` are returned in the issue handoff because a commit cannot embed its own content-derived SHA.
- Rejected relationship correction: `b4ce6e452e1b97e5d2e2eacd9066a8ff9a9bceee` has exact parent `d7fe610592888e0beecf42d39a7d08e0bf6faaa1`, not `9ef844b`.
- Runtime: `Node v24.19.0` via `npx -y node@24`
- Rejected default runtime: `Node v22.20.0` (below repository and release-gate minimum)
- OS: Windows, `process.platform === "win32"`, x64
- Vitest: `4.1.10`
- Gemini: absent from `PATH` (`where gemini` non-zero as evaluated by the tests/verifier)
- Isolation: the evidence parent was exported with `git archive --format=zip`, expanded under `PAPERCLIP_RUN_SCRATCH_DIR`, and linked to the workspace's already-installed `node_modules`. The source tree and tree hash were exact; this was not a fresh frozen install, so dependency-install integrity remains parent DHV-50 evidence, not evidence established here. The archive has no `.git` metadata, which is the recorded cause of the tracked-tree secret-scan failure below.
- Shared-worktree warning: the concurrent DHV-70 run left unrelated product/test files modified and an untracked `audit/` tree. They were excluded from the exact-parent archive and from this commit; only the DHV-71 QA inventory/reporting artifact was edited.

## Ledger summary

| Classification | Count | Validity | Condition | Reporting owner / remediation owner |
| --- | ---: | --- | --- | --- |
| Valid platform N/A | 71 | Valid on Windows | `process.platform === "win32"` | Founding Engineer — Windows test-harness portability / none |
| Valid capability N/A | 4 | Valid protocol N/A | Fixture `question.unsupported` or `drift.unsupported` contains a reason | Founding Engineer — provider-driver contract |
| Missing dependency | 3 | Invalid release-evidence gap | `hasGeminiCli === false` | QA/Test Lead — skip reporting and release-evidence gate / Founding Engineer — DHV-100 remediation |
| Mock-only gap | 0 | None observed as a skip | N/A | N/A |
| Unjustified skip | 0 | None observed | N/A | N/A |

The 71 platform rows are distributed across mode-bit, nvm/chmod/shebang, and fake-CLI process tests. The prior 17 `server/drivers/acp/acp.test.ts` rows are intentionally absent: the exact evidence parent runs those cases on Windows, so retaining them would be a stale-ledger failure. The four capability rows are generated only from explicit non-empty unsupported reasons in the driver-contract fixtures. The three live-Gemini rows are backed by hermetic fake tests but do not supply live-binary release evidence.

Per-source counts are enforced by `manifest.json`: 1 service-auth, 1 config, 1 database, 3 live Gemini, 25 Claude, 40 Codex, 4 driver contract, 2 env-path, and 1 secrets test.

### Validity and ownership schema

Manifest schema version 2 makes `valid` a required boolean, not optional descriptive metadata. `valid_platform_na` and `valid_capability_na` require `valid: true`; `missing_dependency`, `mock_only_gap`, and `unjustified_skip` require `valid: false`. Every row requires non-empty `file`, `name`, `condition`, `reason`, `owner`, and `classification` strings. Here `owner` means the reporting owner accountable for maintaining the inventory and release disposition. Every invalid row separately requires a non-empty `remediationOwner` and durable `remediation` reference; every valid row requires `remediation: null`. The verifier rejects schema-version, type, classification/validity, ownership, or remediation contradictions before comparing skips.

## Deterministic commands and observed output

Fresh gate for a checkout containing this verifier:

```powershell
npx -y node@24 scripts/verify-vitest-skip-inventory.mjs
```

The command enforces Node >=24, launches the repository Vitest binary, collects JSON, validates every ledger field and manifest count (including the required boolean `valid` field), computes platform/dependency applicability, and compares skipped tests as a multiset. It fails for a new/unreasoned skip, a stale ledger row, a malformed/incomplete rationale, an ownership/validity contradiction, or any non-zero Vitest run. It does not alter tests or CI.

Report-only reconciliation used for the exact-SHA artifact:

```powershell
npx -y node@24 scripts/verify-vitest-skip-inventory.mjs --report "$env:PAPERCLIP_RUN_SCRATCH_DIR\vitest-f73fd89-exact-node24.json"
```

Observed exit `0`:

```text
Vitest skip inventory: runtime=v24.19.0 platform=win32 gemini=absent expected=78 observed=78
Classes: platform=71, capability=4, missing_dependency=3, mock_only_gap=0, unjustified=0
PASS: report skip inventory exactly matches its reasoned ledger.
```

Negative control:

```powershell
npx -y node@24 scripts/verify-vitest-skip-inventory.mjs --report "$env:PAPERCLIP_RUN_SCRATCH_DIR\vitest-f73fd89-exact-node24.json" --negative-control
```

Observed expected exit `1`, with `expected=78 observed=79`, report-count mismatch, and:

```text
FAIL: new or unreasoned skips:
  + negative-control.test.ts :: DHV-71 synthetic unreasoned skip
```

Exact-SHA Vitest collection command:

```powershell
npx -y node@24 node_modules/vitest/vitest.mjs run --reporter=json --outputFile="$env:PAPERCLIP_RUN_SCRATCH_DIR\vitest-f73fd89-exact-node24.json"
```

Observed exit `1`: 461 suites total, 459 passed, 2 failed; 1,407 tests total, 1,328 passed, 1 failed, 78 skipped. The failing assertion was `server/secret-scan.test.ts` — `secret scan holds the tracked tree clean (a committed dummy token fails this suite)`. Its error was deterministic for this isolation method: `git ls-files failed: fatal: not a git repository`, because `git archive` does not contain `.git` metadata. The failure remains blocking evidence for the wrapper command; it was not skipped, rewritten, or relabeled. The report-only command separately proves exact skip reconciliation without claiming the full test run is green.

The rejected `b4ce6…` artifact expected all 95 rows from `46e9963…` while its own exact checkout observed 78. The correction removes precisely the 17 stale ACP rows and republishes the baseline against the exact evidence parent above.

## Remediation and review state

Exactly one invalid class exists: the three `missing_dependency` live-Gemini canaries. Their reporting owner is the QA/Test Lead, accountable for inventory and release-gate disposition. Their distinct remediation owner is the Founding Engineer under durable issue DHV-100 (`f2cc9e31-a4b8-449b-a922-1d5190ab92e8`), limited to providing a reproducible Node >=24 environment with the repository-supported Gemini executable. DHV-100 must not edit or weaken the tests, use paid spend/production credentials, or overlap Windows harness/capability work.

Independent QA/Test Lead review is still required for the final DHV-71 commit SHA. Until that review is recorded and required GitHub CI for the same SHA succeeds, this work must not be integrated into CI, approved for release, pushed, or treated as a green baseline.
