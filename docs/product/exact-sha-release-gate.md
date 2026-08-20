# Exact-SHA CI and release gate

Status: repository candidate policy. GitHub enforcement is not verified until
the administrator action below is complete.

Required GitHub check context: exact-sha-release-gate

## Non-negotiable failure semantics

- Any failure blocks acceptance and push.
- Absent CI blocks acceptance and push.
- A missing required check blocks acceptance and push.
- Unsupported Node blocks acceptance and push; evidence must use Node 24 or
  newer.
- Unjustified skips block acceptance and push. A skip must be pre-existing,
  named, explained, and accepted by the QA/Test Lead.
- A fix, amended commit, rebase, or merge creates a new SHA and a fresh gate.
  Evidence and approvals from a previous SHA do not transfer.
- Self-approval is prohibited. The developer, independent reviewer, and
  QA/Test Lead identities must be recorded; the developer cannot fill either
  independent verdict.
- No label, actor, command, or emergency note bypasses this gate.

## Candidate sequence

1. The implementing agent commits one scoped batch and records the full
   candidate SHA and parent SHA. It does not declare acceptance.
2. An independent reviewer inspects that exact SHA and records a verdict.
3. The QA/Test Lead independently reviews the same exact SHA, the commands,
   counts, skips, runtime, risks, and CI evidence, then records a verdict.
4. The exact-sha-release-gate GitHub check for that SHA must exist and succeed.
   A green check for a parent, merge ref, amended commit, or different SHA is
   invalid.
5. Only after all evidence is complete may the assigned delivery owner perform
   the authorized push or merge. Record the push result and verify that
   origin/main equals the approved candidate SHA.
6. If the push produces a different SHA or a required post-push check is absent
   or fails, acceptance is revoked and the new SHA needs a fresh gate.

Use .github/release-acceptance-template.md for the durable record. Blank fields,
placeholders, missing links, or implied evidence are not approval.

## What CI runs

The one stable required job checks out and asserts the candidate SHA, uses Node
24 and the pinned pnpm version, performs a frozen-lockfile install, validates
the gate itself, runs the repository-supported gate lint/format check, scans
tracked files for secret shapes, audits dependencies, explicitly runs the route,
import, and security inventories, checks client/server/E2E TypeScript, runs all
Vitest unit/integration tests, builds the production client and server, and
runs all deterministic Playwright specs in e2e against the fake/local harness.

The gate-scoped lint/format command checks the workflow, scripts, templates, and
release documents added by this policy. The repository still has no general
application lint or formatter configuration; this policy does not claim that
broader coverage.

The manual release validator additionally requires the workflow to be selected
from main and accepts only a completed successful check produced by GitHub
Actions whose reported head_sha equals the accepted SHA. A same-named check
for another SHA or from another check producer is not valid evidence.

## GitHub administrator action required

Repository files cannot configure or prove GitHub branch protection. The
2026-08-19 audit found main unprotected, no rulesets, and no check run on the
then-current origin/main.

Owner: Chief of Staff, using Velarixx repository-administrator permissions.

After this workflow is independently approved and present on GitHub, the owner
must configure a branch ruleset or main branch protection with all of the
following:

1. Require a pull request before merging.
2. Require at least one approval, dismiss stale approvals on new commits, and
   require approval of the most recent reviewable push.
3. Require conversation resolution.
4. Require the exact check named exact-sha-release-gate and require the branch
   to be current before merge. Bind the expected check source to GitHub Actions
   if the selected GitHub ruleset interface supports an expected source.
5. Block force pushes and branch deletion.
6. Apply the rule to administrators; do not add bypass actors or bypass labels.
7. Configure the Internal desktop release environment with an independent
   required reviewer and prevent self-review before relying on release.yml.
8. Verify the resulting protection/ruleset and environment via GitHub settings
   or API, then attach the evidence and a successful exact-SHA check URL.

Until those steps are verified, this repository provides a candidate check and
operating policy only. It must not be described as enforced branch protection.

## Release-workflow limitation

GitHub cannot validate Paperclip roles from repository YAML. The acceptance
record and QA/Test Lead verdict remain required operating evidence. The manual
desktop release workflow must not be dispatched until the protected exact SHA
has completed this gate and the configured GitHub environment reviewer has
approved it. Repository-admin configuration is therefore a hard external
dependency, not an assumed control.

The release workflow's presence does not authorize a dispatch. DHV-65 does not
push, release, deploy, provision credentials, mutate an environment, or change
GitHub administration. Those remain separate, explicitly authorized actions.
