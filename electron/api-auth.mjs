// Per-launch API token helpers — pure, unit-testable without Electron.
// Main mints one 256-bit token per app launch, hands it to the forked
// server (env), and injects it as an Authorization header on every
// renderer request to the server origin via webRequest. Header injection
// at the network layer is deliberate: EventSource (the SSE stream) cannot
// set request headers itself, and this way raw fetches and the api()
// choke point in src/state/store.tsx are all covered uniformly, on
// whichever fallback port the server actually bound.
import { randomBytes } from "node:crypto";

export function mintApiToken() {
  return randomBytes(32).toString("hex");
}

/** webRequest URL filter for the packaged server origin (final port,
 * after any port fallback). */
export function serverUrlFilter(port) {
  return [`http://127.0.0.1:${port}/*`];
}

export function withAuthHeader(requestHeaders, token) {
  return { ...requestHeaders, Authorization: `Bearer ${token}` };
}
