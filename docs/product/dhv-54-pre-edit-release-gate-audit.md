# DHV-54 pre-edit release-gate audit

Audit date: 2026-08-19

Audited local HEAD: `941d9db0ef27f812246264cd43bba19d643dc75f`

This record was written before changing the release gate. The checkout was
clean and `main` was two commits ahead of `origin/main`; those commits were
treated as concurrent Founding Engineer work and were not altered.

## Repository evidence

| Surface | Observed state | Gap against the board gate |
| --- | --- | --- |
| Runtime and package manager | `package.json` requires Node `>=24` and pins `pnpm@10.33.0`; the local default was Node `v22.20.0`. | Supported-runtime evidence must use the documented `npx -y node@24` fallback, and CI must enforce Node 24 before running checks. |
| Root scripts | `typecheck`, `test`, `build`, `typecheck:smoke`, and `test:smoke` exist. No lint or format-check command is declared. | CI does not have a repository-supported lint/format command to run. This cannot be silently described as covered; a linked repair item is required. |
| TypeScript | `typecheck` checks `src` and `server`; `typecheck:smoke` checks the Playwright TypeScript. | Current CI runs only `typecheck`; it does not explicitly check E2E TypeScript. |
| Unit/integration tests | `pnpm test` runs the Vitest suite. Import hygiene, the production route inventory, and secret-scan wiring are test-enforced in `server/import-hygiene.test.ts`, `server/saas-route-surface.test.ts`, and `server/secret-scan.test.ts`. | Current CI runs the aggregate suite but does not expose these release-significant inventories as an explicit gate step. |
| Production build | Current CI invokes `pnpm exec vite build`. | That omits the server TypeScript portion encoded by the repository's `pnpm build` command. |
| Deterministic Playwright | `e2e/fake-engine-smoke.spec.ts` and `e2e/session-boundary.spec.ts` use the fake/local harness; `test:smoke` runs only the former. | Current CI installs no browser and runs no deterministic Playwright E2E. The second deterministic spec has no root command. |
| CI triggers | `.github/workflows/ci.yml` runs for non-draft PRs and manual dispatch, ignores documentation-only changes, and does not run on pushes to `main`. | A final SHA can lack any CI run; a missing run cannot block direct pushes. Draft and docs-only changes can have no check. |
| CI identity | The job is named `typecheck + test + build`; checkout uses the default PR merge ref. | There is no durable, stable exact-SHA required-check context and no checkout assertion tying evidence to the PR head SHA. |
| Release workflow | `.github/workflows/release.yml` validates Node 24, frozen install, typecheck, and tests before packaging. | It can be manually dispatched without proving exact-SHA QA approval or the required CI check. Repository code alone cannot verify a Paperclip approval identity. |
| Release documentation | `docs/product/dhv-5-release-acceptance-v1.md` records workflow coverage and old Node 22 smoke evidence. | There is no reusable exact-SHA record containing parent, developer evidence, both independent verdicts, commands/counts, skips, CI URLs, risks, push result, or `origin/main` equality. |
| PR template | Requests verification and a short checklist. | It does not forbid self-approval, require exact-SHA QA approval, or capture the required-check state. |

## GitHub enforcement evidence

Read-only GitHub API checks produced:

- `GET /repos/Velarixx/VelarixBot/branches/main/protection`: HTTP 404,
  `Branch not protected`.
- `GET /repos/Velarixx/VelarixBot/rulesets`: `[]`.
- `GET /repos/Velarixx/VelarixBot/commits/46e9963/check-runs`:
  `total_count: 0`.
- Recent `main` workflow history contained scheduled canaries, docs pushes,
  and manual releases, but no CI run for current `origin/main`.

Therefore repository changes can define a candidate gate but cannot honestly
claim server-side enforcement. A Velarixx repository administrator, owned by
the Chief of Staff, must configure and independently verify branch/ruleset
protection after the workflow exists on GitHub.

## Commands used for the audit

```text
git status --short --branch
git log -5 --oneline --decorate
node --version
corepack pnpm --version
Get-Content package.json, .github/workflows/*.yml, release docs, and test inventories
gh api repos/Velarixx/VelarixBot/branches/main/protection
gh api repos/Velarixx/VelarixBot/rulesets
gh api repos/Velarixx/VelarixBot/commits/46e9963/check-runs
gh api "repos/Velarixx/VelarixBot/actions/runs?branch=main&per_page=10"
```

Observed versions: Windows PowerShell, Node `v22.20.0` (unsupported default),
and pnpm `10.33.0`.
