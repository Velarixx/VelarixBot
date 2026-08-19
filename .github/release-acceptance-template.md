# Exact-SHA release acceptance record

Incomplete, placeholder, or self-authored independent fields mean BLOCKED.

## Candidate identity

- Candidate SHA:
- Parent SHA:
- Branch or review ref:
- Scope / linked issues:

## Developer evidence

- Developer identity:
- Developer verdict:
- Evidence location:
- Files changed:

## Independent reviewer

- Reviewer identity:
- Relationship to developer:
- Exact SHA reviewed:
- Verdict: APPROVE / BLOCK
- Findings:
- Review timestamp:

## QA/Test Lead

- QA/Test Lead identity:
- Exact SHA reviewed:
- Verdict: APPROVE / BLOCK
- Approval record URL:
- Approval timestamp:

## Exact commands and counts

For every command, record the exact invocation, exit code, passed/failed test
counts, duration, and evidence link or attached output.

| Command | Exit | Passed | Failed | Duration | Evidence |
| --- | ---: | ---: | ---: | --- | --- |
|  |  |  |  |  |  |

## Justified skips

List every skipped test/check with its pre-existing source location, reason,
owner, and QA/Test Lead disposition. Write None only after checking output.

| Skip | Pre-existing reason | Owner | QA disposition |
| --- | --- | --- | --- |
|  |  |  |  |

## Runtime and OS

- OS and version:
- Node exact version (must be 24 or newer):
- pnpm exact version:
- Browser and Playwright revision:
- Environment assumptions:

## CI URLs and status

- Workflow run URL:
- Workflow head SHA:
- Checked-out SHA from Prove exact checkout:
- Overall conclusion:

## Required GitHub checks

| Required context | SHA | Status | URL |
| --- | --- | --- | --- |
| exact-sha-release-gate |  |  |  |

- Branch protection/ruleset evidence URL:
- Missing required checks: None / list:

## Residual risks

- Risk:
- Owner:
- Release disposition:

## Push result

- Push authorized by:
- Push actor:
- Exact command or merge action:
- Result:
- Remote commit produced:

## origin/main equality

- Local approved SHA:
- git rev-parse origin/main:
- GitHub API main SHA:
- Equal: YES / NO
- Post-push required-check URL/status:

## Final gate

- Any failure: NO / YES (YES means BLOCKED)
- Absent CI: NO / YES (YES means BLOCKED)
- Missing required check: NO / YES (YES means BLOCKED)
- Unsupported runtime evidence: NO / YES (YES means BLOCKED)
- Unjustified skip: NO / YES (YES means BLOCKED)
- SHA changed after approval: NO / YES (YES requires a fresh gate)
- Final disposition: APPROVED / BLOCKED
