# Version 0.4.5 delivery record

## Scope

This release contains the fixes documented in [live-test reliability fixes](live-test-fixes/README.md): preserved partial Codex output on Stop, paused cancellation and explicit Resume, recovery from stale setup errors, native bot self-updates, available-engine defaults, a bounded model menu, preserved chat line breaks, and fresh run timers.

Implementation commit: `92a60795d72612f813de181c06d2515402d85635`.

The release candidate is the commit containing this record and the package version bump to 0.4.5. Its complete SHA is recorded in the release workflow's `accepted_sha` input and in the immutable GitHub permalink supplied as `acceptance_record_url`. The release workflow must verify that this SHA equals main's workflow SHA and has a successful `exact-sha-release-gate` check produced by GitHub Actions before packaging.

## Owner-directed delivery

On 2026-09-25, after being told that the repository policy blocks publication without exact-SHA CI and that an explicit exception was needed, the repository owner instructed: “push to main and build 0.4.5”.

This authorizes direct publication to main and release delivery for 0.4.5. It is a scoped owner instruction overriding the local policy's pre-publication and independent-review prerequisites for this delivery. No independent reviewer or QA/Test Lead approval is claimed. No repository policy, branch-protection setting, or CI gate is changed. The automated exact-SHA CI requirement before packaging remains in place.

## Developer evidence

Developer: Codex, implementing agent. Local runtime: Node 24.19.0 on Windows.

- Client, server, and browser-test TypeScript checks passed after the final implementation edit.
- Focused server/UI regression batch: 51 passed, 40 existing Windows skips.
- Codex driver contract cases: 13 passed; 52 other-provider cases were excluded by the Codex filter.
- Import, route, and security inventories plus workflow/notification tests: 33 passed.
- Packaging tests after temporary-file cleanup correction: 15 passed.
- Focused browser regressions: 4 passed, including Stop/reload/Resume, model selection, line breaks, and timers.
- Production client build and repository gate validators passed.
- The first full local unit/integration run had 1,721 passes, 3 temporary-directory cleanup failures, and 80 existing platform skips. The cleanup failures were corrected and the affected 15-test file passed afterward.
- Subsequent broad local test runs were interrupted because helper consoles disrupted the owner's desktop. They are not passing-suite evidence. The final shared test-server `windowsHide` setting was typechecked but not runtime-tested locally.

Screenshots and regression descriptions are in the linked implementation record. All harness tests use fake engines and isolated temporary data. The installed app and user conversations were not modified.

## Release validation and limitations

The exact-SHA CI run, followed by the existing release workflow, provides the final automated test, build, packaged-server, resource, and checksum evidence. These results must be inspected before reporting release success. Developer checks above do not substitute for those runs.

Windows and macOS packages retain the repository's existing unsigned/manual-trust distribution process. Live-provider behavior after installation remains a separate validation step. There is no claim of independent QA approval or verified repository protection.
