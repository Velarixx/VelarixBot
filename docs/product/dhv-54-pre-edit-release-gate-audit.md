# DHV-65 independent pre-edit release-gate audit

Audit date: 2026-08-20

Durable QA baseline: 46e9963774a45f90c1414b93a8ce4a6b57ca12e8

Starting HEAD inspected: b4ce6e452e1b97e5d2e2eacd9066a8ff9a9bceee

Initial candidate parent after non-overlapping concurrent commits:
ade36472649c2710001d88caf30f42403de13b16

The QA/Test Lead closed DHV-50 with a durable CHANGES REQUIRED ledger for
the baseline SHA. The 2026-08-20 board comment cleared the stranded execution
blocker and directed DHV-65 to continue from the current repository state.
The assigned paths were clean at the starting SHA above. Before this batch was
committed, two non-overlapping concurrent batches advanced HEAD through
f7c85d1 to the candidate parent recorded above. The shared checkout also
contained an untracked audit/ directory owned by concurrent DHV-66 work; it
was treated as read-only and excluded from this batch.

Commit 272863088f37974a706b495775a4a0b310e1dd40 is the quarantined DHV-54
proposal. Its author evidence and verdict are not independent DHV-65 evidence.
This audit re-derived the required behavior from the repository commands,
DHV-50 ledger, and DHV-65 acceptance criteria before editing the assigned
release-control files.

## Independent decision record

| Control | Repository evidence | DHV-65 decision and justification |
| --- | --- | --- |
| Candidate identity | Pull requests expose pull_request.head.sha; pushes and manual runs expose github.sha. | Use one job named exact-sha-release-gate, check out the derived candidate explicitly, require a lowercase full SHA, and compare it to git rev-parse HEAD. The stable name is the only check context administrators should require. |
| Runtime and package manager | package.json requires Node >=24 and pins pnpm@10.33.0; the host default is Node 22. | CI uses Node 24 and Corepack pnpm. Local evidence must use npx -y node@24; default-Node results are not acceptance evidence. |
| Dependency integrity | The repository has a committed pnpm lockfile. | pnpm install --frozen-lockfile is mandatory. The validator rejects a non-frozen install, ignored scripts, and soft-failed steps. |
| Lint and format | No repository-wide ESLint, Prettier, Biome, or dprint command/config exists. | Run the scoped release-file whitespace/JSON validator and state this limitation. Do not claim application-wide lint coverage. |
| Secret and dependency checks | scripts/secret-scan.mjs scans Git-tracked files; pnpm supports advisory auditing. | Run both explicitly. Missing commands or non-zero exits block the single required job. |
| Route/import/security inventories | server/import-hygiene.test.ts, server/saas-route-surface.test.ts, and server/secret-scan.test.ts are release-significant Vitest inventories. | Expose them as a focused step and still run the complete Vitest suite afterward. |
| TypeScript and build | typecheck checks client and server; typecheck:smoke checks E2E sources; build checks client/server and produces the Vite build. | Run both typecheck commands and the repository production build, rather than only vite build. |
| Deterministic browser journey | The applicable fake/local specs are fake-engine-smoke.spec.ts and session-boundary.spec.ts; the release Playwright config fixes one worker and disables full parallelism. | Install pinned Chromium and run both specs through the isolated config. Browser installation or test failure is visible and blocking. |
| Skip semantics | Vitest and Playwright can emit skips without returning non-zero. The current suite has a committed skip-inventory test, but exact-run skips still require human disposition. | CI runs the inventory; the acceptance record separately requires every observed skip, pre-existing reason, owner, and QA/Test Lead verdict. No implementation agent may self-approve a skip. |
| Release precondition | The existing manual desktop workflow builds and publishes artifacts. Repository YAML cannot authenticate Paperclip roles or configure GitHub protection. | Validation requires the selected main SHA, the explicit accepted SHA, an HTTPS acceptance record, and a completed successful GitHub Actions check whose head_sha is identical. The workflow is not to be dispatched until external review/environment controls are configured. |
| External enforcement | DHV-50 found no check run for the baseline. The earlier read-only GitHub audit found no branch protection or rulesets. | The Chief of Staff must configure the exact ruleset and independently protected release environment documented in exact-sha-release-gate.md. This batch performs no GitHub-admin mutation, push, release, deployment, or credential provisioning. |
| Validator credibility | String-presence checks alone can remain green if a critical command is weakened. | The validator now executes fail-closed in-memory mutations covering runtime, required-context name, checkout SHA, frozen install, soft-failure wiring, deterministic specs, exact check SHA, check producer, and QA identity. |

## Pre-edit commands and observations

    git rev-parse HEAD
    git rev-parse origin/main
    git status --short --branch
    git log --oneline -- assigned release-gate paths
    git show 941d9db:.github/workflows/ci.yml
    git show 941d9db:package.json
    GET /api/issues/DHV-50 and its durable comments
    node --version

Observed before edits:

- Starting HEAD: b4ce6e452e1b97e5d2e2eacd9066a8ff9a9bceee.
- Candidate parent: ade36472649c2710001d88caf30f42403de13b16.
- origin/main: 46e9963774a45f90c1414b93a8ce4a6b57ca12e8.
- Host Node: v22.20.0, unsupported for acceptance.
- Assigned release-gate paths: clean.
- Shared untracked path: audit/, excluded and untouched.

This document is an implementation audit, not an approval. A new candidate
SHA requires separate Test/Release review, QA/Test Lead approval, and successful
required GitHub CI for that same SHA.

## Superseded local candidate

The first local candidate, 8982765cd406267f5df0b6713f25001322052864, failed
its isolated release-gate validator because the validator assumed LF input
while Git had committed the workflow and policy files with CRLF line endings.
That SHA is blocked and none of its run evidence transfers. Concurrent commits
advanced main before the correction, so rewriting or amending shared history
was not safe. The correction normalizes CRLF to LF in memory and is delivered
as a new commit. The DHV-65 handoff records the replacement SHA and parent;
independent reviewers must review the replacement SHA's complete release-gate
tree, not only its parent diff.
