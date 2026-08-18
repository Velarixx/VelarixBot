# Deterministic fake-engine smoke

The focused browser smoke uses the existing `server/testing/harness.ts` and
`server/testing/fake-claude-cli.ts` seams. It launches the real local HTTP/SSE
server with a unique throwaway home and API token, serves a fresh Vite build,
and never contacts a production provider or mutable external service.

## Prerequisites

- Node 24 or newer (the version declared by `package.json`; CI uses Node 24)
- Corepack with pnpm 10.33.0, or the same pnpm version installed directly
- Playwright Chromium installed with `pnpm exec playwright install chromium`

## Commands

```text
pnpm typecheck:smoke
pnpm test:smoke
```

`test:smoke` builds the current UI before starting Playwright. The harness
creates an isolated temporary home, seeds only the scripted fake Claude engine,
waits on the health endpoint, and removes the temporary state after the test.
The test uses Playwright's observable locator assertions and connection events;
it contains no arbitrary sleeps.

The journey starts in a clean browser context and throwaway home (including the
repository's deterministic starter bot), completes onboarding, and creates a
bot. A page-scoped EventSource adapter delegates to the real harness stream and
emits explicit `error` and `open` lifecycle events to exercise the delivered
connection-state contract without timing a socket failure. The test verifies the
unsent draft remains visible, restores the connected state, sends the preserved
draft, and verifies the scripted fake response is rendered without subagent
noise.
