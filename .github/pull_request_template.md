<!--
Please read CONTRIBUTING.md first — it's short. One concern per PR;
big changes should have an issue agreeing on the approach before code.
-->

## What changed

## Why

## How it was verified

<!-- commands run, platforms tested on, what you clicked through -->

## Exact-SHA release gate

<!-- Use .github/release-acceptance-template.md for the durable evidence record. -->

- Candidate SHA:
- Parent SHA:
- Acceptance record:
- Required exact-sha-release-gate run:
- Independent reviewer:
- QA/Test Lead:

## Screenshots (UI changes)

<!-- before/after images; video for anything animated -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm test` pass locally
- [ ] Server behavior changes come with tests (see CONTRIBUTING.md → Tests)
- [ ] No `dist-server/` edits (it's build output)
- [ ] macOS-only code is platform-gated; no `shell: true` / cmd.exe string-building
- [ ] No secrets in logs, responses, events, or argv
- [ ] The candidate SHA and parent are recorded
- [ ] An independent reviewer approved this exact SHA
- [ ] The QA/Test Lead approved this exact SHA
- [ ] The required exact-sha-release-gate check succeeded for this SHA
- [ ] Every skip is pre-existing, justified, and accepted by the QA/Test Lead
- [ ] I am not using my own review as independent or QA approval
