// Per-launch API token helpers — pure, unit-testable without Electron.
// The user-session service host mints one 256-bit token, hands it to the
// forked server (env only — never argv), writes it to the 0600 sidecar
// (~/.velarixbot/service-auth.json), and the packaged GUI injects that
// same token on every renderer request via webRequest. Attach must not
// mint a second token. Header injection at the network layer is
// deliberate: EventSource (the SSE stream) cannot set request headers
// itself, and this way raw fetches and the api() choke point in
// src/state/store.tsx are all covered uniformly, on whichever fallback
// port the service actually bound. The token is never in /api/health.
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
