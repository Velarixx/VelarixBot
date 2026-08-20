# DHV-100 live-Gemini prerequisite evidence

## Verdict

**READY FOR INDEPENDENT QA REVIEW.** All three unchanged live-Gemini canaries executed and passed with the repository-supported Gemini CLI 0.55.1 under Node v24.19.0. This closes only the `missing_dependency` execution prerequisite. It does not change the tests, their skip condition, the DHV-71 ledger, CI, provider capabilities, or the Windows POSIX harness.

## Acceptance criteria and non-goals

Acceptance evidence must identify the exact executable and version, exact provisioning command, Node and OS, exact candidate SHA, all three full test names and results, credential/redaction controls, and residual risk.

Explicit non-goals are production credentials, paid API use, production deployment, test edits or relabeling, CI integration, the Windows POSIX harness, and unsupported driver-capability work. No file under `server/`, `src/`, `electron/`, `eval/`, or `.github/` was changed for this issue.

## Reproducible prerequisite

The verified environment was provisioned into Paperclip run-owned scratch with npm 10.9.3:

```powershell
$toolRoot = Join-Path $env:PAPERCLIP_RUN_SCRATCH_DIR 'dhv-100-tools'
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
npm install --prefix $toolRoot --no-audit --no-fund --save-exact node@24.19.0 @google/gemini-cli@0.55.1
```

Observed install result: exit `0`, seven packages added. The resulting exact runtime and executable were:

- Node: `$toolRoot\node_modules\node\bin\node.exe`, version `v24.19.0`, SHA-256 `3602F2BB1A10F2CBAB4C36886218A33C1AB3DB87290E73B033C46C77147D0237`
- Gemini command: `$toolRoot\node_modules\.bin\gemini.cmd`
- Gemini package entrypoint: `$toolRoot\node_modules\@google\gemini-cli\bundle\gemini.js`, version `0.55.1`, SHA-256 `29943EE4B51FBB3AE5475FF30ABB247B7034F6121BDAFCAA5AE762FB479E3D9C`
- Package source recorded by the installed manifest: `@google/gemini-cli` from `github.com/google-gemini/gemini-cli`, Apache-2.0

The package install is a free registry download; it does not authenticate to Gemini or submit a model request. The exact versions are deliberately local to the evidence environment rather than added as repository dependencies.

## Credential-isolated verification command

The following is the exact verification shape used after provisioning. The disposable profile prevents the Gemini process from reading the operator's Gemini, Google Cloud, or application-default credential stores. Known API-key, ADC, project, Vertex, and Cloud SDK selectors are removed from the child environment before Gemini starts.

```powershell
$node24 = Join-Path $toolRoot 'node_modules\node\bin\node.exe'
$bin = Join-Path $toolRoot 'node_modules\.bin'
$safeHome = Join-Path $env:PAPERCLIP_RUN_SCRATCH_DIR 'dhv-100-home'
New-Item -ItemType Directory -Force -Path `
  (Join-Path $safeHome 'AppData\Roaming'), `
  (Join-Path $safeHome 'AppData\Local') | Out-Null

$env:PATH = $bin + ';' + $env:PATH
$env:HOME = $safeHome
$env:USERPROFILE = $safeHome
$env:APPDATA = Join-Path $safeHome 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $safeHome 'AppData\Local'
$env:CI = 'true'
$env:NO_COLOR = '1'
Remove-Item `
  Env:GEMINI_API_KEY, `
  Env:GOOGLE_API_KEY, `
  Env:GOOGLE_APPLICATION_CREDENTIALS, `
  Env:GOOGLE_CLOUD_PROJECT, `
  Env:GOOGLE_CLOUD_LOCATION, `
  Env:GOOGLE_GENAI_USE_VERTEXAI, `
  Env:CLOUDSDK_CONFIG `
  -ErrorAction SilentlyContinue

git rev-parse HEAD
& $node24 --version
& (Join-Path $bin 'gemini.cmd') --version
& $node24 node_modules\vitest\vitest.mjs run `
  server\drivers\acp\gemini.test.ts `
  --reporter=verbose `
  -t 'Gemini live CLI'
```

The repository's `server/testing/setup.ts` adds a second boundary by replacing HOME and USERPROFILE with a new per-test temporary directory before the test module and driver are imported. The canaries exchange only ACP `initialize` and signed-out `session/new` messages; they send no user prompt and the signed-out path cannot make an authenticated model request. No secret values were printed, persisted in the repository, or included in this evidence.

## Exact candidate and results

- Candidate SHA: `e06b571df683c7e79c69e99fda4e352abbbe9b08`
- Git tree: `7a856dc76f02192830777ce0002a3394088fde16`
- OS: Microsoft Windows `10.0.26200`, x64 (`process.platform === "win32"`)
- Node: `v24.19.0`
- Gemini CLI: `0.55.1`
- Vitest: `4.1.10`

Observed exit `0`:

| Unchanged full test name | Result | Duration |
| --- | --- | ---: |
| ``Gemini live CLI (skipped when `gemini` is not installed) > speaks ACP on the exact spawn argv (with and without -m) and still accepts the deprecated flag`` | PASS | 5.005 s |
| ``Gemini live CLI (skipped when `gemini` is not installed) > advertises the pinned auth method ids in initialize.authMethods`` | PASS | 1.579 s |
| ``Gemini live CLI (skipped when `gemini` is not installed) > driver snapshot against the real binary degrades honestly — never a grey-out lie`` | PASS | 4.143 s |

Vitest summary: one test file passed; three selected tests passed; 35 non-selected tests were skipped by the `-t` filter; total duration 11.16 s. None of the three live canaries was skipped by `hasGeminiCli`.

## Reversible decision and residual risk

Decision: keep Node and Gemini as an ephemeral, exact-version evidence prerequisite. This avoids converting a live-provider QA canary into an application dependency or broad CI/platform commitment before DHV-71 review. The alternative is a dedicated CI image containing the same pinned tools, but CI integration is intentionally outside DHV-100 and requires the parent gate.

Residual risk:

- npm registry bytes are version-pinned but were not independently provenance-attested beyond installed version, manifest source, and local executable hashes.
- The run proves Windows x64 behavior at this SHA; it does not establish POSIX harness portability or any unsupported provider capability.
- The credential boundary covers filesystem profiles and known Gemini/Google environment selectors. The run did not instrument outbound sockets, so it does not independently prove that the CLI made no unauthenticated update or telemetry check. With no credential source and no prompt, such a check cannot become paid model inference in this evidence path.
- The canaries validate ACP startup/auth metadata and honest snapshot degradation only. They do not validate a signed-in model turn.
- Independent QA must rerun the command against the final evidence commit SHA. DHV-71 release acceptance and any CI adoption remain separate decisions.
