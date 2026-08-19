# DHV-28 secure SaaS sign-in and session UX contract

- Version: 1.0
- Date: 2026-08-19
- Status: Review artifact; no authentication implementation is authorized
- Owner: UX/Product Engineering
- Implementation integrator: Founding Engineer

## Outcome and scope

This artifact defines the fail-closed experience at VelarixBot's future SaaS session boundary. It covers the first visit through sign-out, supplies stable client state names and transport classes, and preserves the existing desktop behavior. It does not implement or claim GitHub OAuth, session creation or revocation, cookies, tenant business routes, public binding, deployment, or a new navigation hierarchy.

The contract applies only when a trusted runtime/build decision explicitly activates SaaS mode. A query string, local-storage value, request payload, or failed credential must never switch modes.

## Evidence inspected

| Path or issue evidence | Finding used by this contract |
| --- | --- |
| `docs/product/dhv-7-primary-ux-state-audit-v1.md` | State feedback belongs at the scope that owns recovery; drafts and usable context should be preserved when safe; loading must not become empty; focus changes only for deliberate gates, dialogs, and submitted errors. |
| `docs/architecture/0002-internal-user-session-boundary.md` | SaaS sessions resolve to internal UUID identities; invalid credentials intentionally collapse to one result; provider metadata is mutable and not the product identity. |
| `src/main.tsx`, `src/App.tsx` | The current renderer mounts `StoreProvider` around the single desktop `Shell`; there is no SaaS session gate or URL router. |
| `src/state/store.tsx` | Mounting the store immediately starts snapshot, configuration, routine, and SSE requests. Its generic `api()` exposes raw server error strings and has no semantic authentication adapter. |
| `src/components/ConnectionExperience.test.ts` | Delivered desktop connection behavior distinguishes initial connection from reconnection and preserves the composer draft while disconnected. |
| `electron/api-auth.mjs`, `electron/api-auth.test.ts` | Electron injects the per-launch desktop bearer into fetch and EventSource requests at the network layer. The renderer neither handles nor displays that credential. |
| `electron/main.mjs`, `electron/service-auth.mjs` | The committed desktop shell remains loopback-bound and obtains its local attach credential outside renderer UX; tokens stay out of health output and UI. |
| Committed `server/auth.ts` at `HEAD` | Desktop `/api/*` uses bearer, loopback Host, and loopback Origin checks, with only `/api/health` exempt. |
| DHV-24 issue acceptance criteria and handoff comment, inspected read-only | Scoped commit `1591d67` delivered opt-in SaaS mode, valid server-side session-cookie resolution, uniform minimal 401, exact HTTPS Origin enforcement for mutations, a minimal identity probe, and no desktop/COMMS fallback. Independent review is still required. |
| DHV-24 delivered files: `docs/architecture/0006-mode-aware-request-principal-boundary.md`, `server/auth.ts`, `server/auth.test.ts`, `server/saas-auth.test.ts`, `server/app.ts`, `server/routes/context.ts`, `server/routes/session.ts`, `server/index.ts` | `desktop` remains the default, `saas` is explicit opt-in, `/api/session` is the only authenticated SaaS probe, and SaaS business routes remain undispatched. These files were inspected and not modified. |
| DHV-26 worktree evidence: `docs/architecture/0007-user-workspace-binding-boundary.md`, `server/db/migrations.ts`, `server/db/database.test.ts`, `server/repositories/index.ts`, `server/repositories/user-workspace-bindings.ts`, `server/repositories/user-workspace-bindings.test.ts` | User/workspace persistence is concurrent, server-owned work and outside this UX artifact. These files were not modified. |
| `package.json` | The repository has Vitest/typecheck commands but no documentation-specific lint task. |

DHV-24 has delivered commit `1591d67` but remains in progress pending independent review. This contract depends on that reviewed result and must be reconciled if review changes it.

## Non-negotiable mode boundary

```text
trusted application mode
|-- desktop (default) -> current Shell + StoreProvider -> loopback bearer UX only
`-- saas (explicit)   -> SessionBoundary
                         |-- not authenticated/unknown -> no product shell or tenant data
                         `-- authenticated             -> eligible for a later tenant-safe shell
```

### Desktop loopback bearer UX

- Keep today's initial connect, connected, reconnecting, and local-server failure states. Do not relabel a bearer failure as "Sign in required."
- Never show GitHub, callback, cookie-session, account, or sign-out UI merely because a desktop API request returns 401/403 or the server is unavailable.
- The bearer remains Electron/server infrastructure. Never put it in React state, copy, logs, URLs, analytics, screenshots, or support detail.
- SaaS mode must not be inferred from the absence of Electron APIs. Development and failure cases must still receive an explicit trusted mode.

### SaaS cookie-session UX

- Mount the session boundary before `StoreProvider` or any product-shell data fetch. Until authentication is confirmed, render no bots, groups, messages, routines, approvals, workspace names, cached tenant content, or tenant-shaped empty states.
- The browser sends an HttpOnly cookie by normal same-origin credential behavior; the client never reads, stores, echoes, or diagnoses the cookie.
- A session probe proves only that authentication succeeded. It does not authorize SaaS business routes or imply tenant-safe product data is available.
- Every unknown, malformed, missing, expired, or revoked session has the same server detail and public sign-in outcome. The client may vary copy only from its own prior state (first visit versus a previously authenticated session), never from a server-supplied reason.

## SaaS state inventory

The names below are semantic UI states, not provider statuses or route names. Copy is intent-level and may be editorially tightened without changing behavior.

| Semantic state and trigger | User-facing copy intent | Permitted actions | Draft and context preservation | Accessibility and focus | Retry semantics | Security-safe detail boundary |
| --- | --- | --- | --- | --- | --- | --- |
| `session_checking` — first SaaS visit or explicit session recheck | “Checking your session…” Name the object; do not imply sign-in success. | None during the initial bounded check. | Keep only a sanitized same-origin return path. Render no tenant cache or tenant-shaped skeleton. | `role="status"`, polite live region, and `aria-busy="true"` on the gate. Leave focus in place; do not focus a spinner. | The idempotent probe may use bounded backoff. If it cannot resolve, move to `service_unavailable`; never spin indefinitely. | No cookie, account, tenant, provider, request, or transport detail. |
| `sign_in_required` — probe returns the uniform unauthenticated class on first visit | “Sign in to continue.” Explain that GitHub will be used only as the sign-in handoff; do not claim a workspace exists. | **Continue with GitHub**; optional **Retry session check**. No product-shell actions. | Preserve a sanitized same-origin return path and non-sensitive pre-auth UI input in memory only. Do not load or name prior tenant context. | On entry, focus the gate heading (`tabIndex=-1`); the sign-in control has an explicit accessible name. | Provider handoff starts only from the user action. A probe retry is manual; a 401 remains here without escalating copy. | Never say whether an account, invitation, email, GitHub login, or tenant is recognized. No technical detail disclosure. |
| `sign_in_pending` — user started the future provider handoff | “Continue in GitHub to sign in.” Make the external handoff and unfinished status explicit. | **Cancel** back to required; **Try again** only after cancellation, timeout, or a returned failure. Prevent duplicate launches while pending. | Retain the sanitized return path and safe pre-auth input in memory. Do not expose the shell behind the pending view. | Keep focus on the initiating control until navigation; on return, focus the resulting state heading. Announce pending status politely and mark the group busy. | Do not auto-open repeated provider windows or replay a callback. A new attempt must mint a new server-owned authorization transaction. | Show no authorization URL parameters, OAuth code/state, provider payload, scopes beyond approved copy, or popup error internals. |
| `sign_in_declined` — GitHub denial or user cancellation, intentionally indistinguishable | “Sign-in wasn’t completed.” Reassure that nothing was changed; do not blame the user or provider. | **Try again**; **Back** to the required state. | Preserve only the same safe pre-auth context as pending. Never reveal a tenant based on the attempted identity. | Use `role="alert"` for the returned result and focus its summary. Actions follow in logical order. | Always start a fresh handoff; never replay the prior callback or reuse its state. | Do not distinguish denial from cancel in public detail, echo provider descriptions, or disclose account/tenant matching. |
| `callback_rejected` — future callback adapter reports missing, malformed, mismatched, expired, or replayed callback state | “We couldn’t verify that sign-in attempt. Start again.” Frame this as a safe restart. | **Start again**; optional **Back to sign in**. | Immediately scrub auth parameters from the visible URL/history. Preserve only the sanitized return path; clear provider-derived data. | `role="alert"`; focus the error heading after URL cleanup. Do not place raw callback text in an accessible description. | Never retry or reload the callback URL. A retry is a brand-new authorization transaction. | Collapse all callback-validation causes. Never expose OAuth code/state, correlation IDs, provider response, stack trace, or whether identity lookup occurred. |
| `session_ended` — a previously authenticated probe or request returns the uniform unauthenticated class | “Your session ended. Sign in again to continue.” Do not say expired versus revoked. | **Sign in again**. No tenant mutation or shell action. | Immediately hide tenant UI and suspend in-memory drafts. Restore only if a separately approved continuity mechanism proves the same authorized context; otherwise clear. Do not promise recovery across reload. | Announce urgently with `role="alert"`, then focus the gate heading. Do not leave focus in hidden tenant content. | Start a fresh sign-in only from user action. Repeated 401 stays ended/required; no credential fallback. | Never reveal expiration, revocation, token shape, account state, tenant existence, or which credential check failed. |
| `service_unavailable` — probe gets network failure, timeout, malformed/non-JSON response, 5xx, or an unavailable contract | “We can’t check your session right now.” Distinguish service reachability from a rejected sign-in. | **Try again**; optional safe support/help link if one is later approved. | Fail closed: hide all tenant content. Keep an already-open draft only in memory while status is unknown; restore after successful revalidation, or clear on sign-out/new identity. | Background loss uses a polite live update; failure of a user-triggered retry uses `role="alert"`. Focus the summary after a submitted retry fails. | Bounded automatic retry is allowed only for the idempotent probe. Always expose manual retry. Do not auto-start OAuth. Respect `Retry-After` if a later response supplies it. | No raw status text, hostname, stack, body, request ID, provider status, cached identity, or tenant hint. Detailed diagnostics stay server-side and redacted. |
| `authenticated` — the reviewed probe returns its allowlisted success shape | “Signed in.” Add a human-readable name/avatar only after a separate allowlist decision; never render the internal UUID. | **Continue** to an independently authorized tenant-safe surface; **Sign out**. | Restore only context proven safe for the active authorization boundary. Never use a cached workspace label to infer access before its own authorized load succeeds. | Announce “Signed in” politely. When the user continues, focus the destination’s main heading; do not announce or focus hidden identifiers. | Background revalidation must not create a second sign-in flow. A later 401 becomes `session_ended`; network/5xx becomes `service_unavailable`. | Treat the current `/api/session` UUID as opaque control data. Do not render, log, copy, place in URLs, or send to analytics. A 200 does not disclose or prove tenant existence. |
| `sign_out_confirm` — authenticated user requests sign-out | “Sign out on this device?” State that unsent work will be cleared; do not claim all sessions will end. | **Cancel** (safe default) and **Sign out**. | Cancel restores all current context. Confirm freezes mutations and prepares to clear visible tenant data and drafts. | Use a labelled modal dialog, focus its heading/least-destructive action, trap focus, support Escape as Cancel, and return focus on Cancel. | No request until explicit confirmation. Prevent duplicate confirms. | Do not show session/account IDs, cookie names, other devices, or unverifiable global-session claims. |
| `sign_out_pending` — confirmed sign-out awaiting a server result | “Signing out…” | None except a safe **Cancel** only if the future server contract can actually cancel; default is no action. | Stop mutations; hide or inert tenant content. Drafts are no longer recoverable in the UI. | Mark the dialog busy and announce progress politely. Keep focus within it. | Do not duplicate a pending revocation request. Timeout becomes `sign_out_unconfirmed`. | No request body, cookie, revocation detail, or server payload. |
| `signed_out` — server confirms revocation or confirms there is no authenticated session | “You’re signed out.” | **Sign in again**. | Clear tenant data, identity projection, drafts, return targets that contain tenant context, and query fragments before presenting sign-in. | Announce completion politely, close the dialog, and focus the sign-in heading. | Sign-in again creates a fresh transaction. Do not restore the old shell from cache. | Do not reveal which server-side record changed or whether another session/device exists. |
| `sign_out_unconfirmed` — network/5xx prevents confirmation | “Your work is hidden, but we couldn’t confirm sign-out. Try again before using this device for another account.” | **Try sign-out again**; **Close this window** guidance. Never return to the shell from this state. | Clear/hide tenant UI and drafts locally. Keep only enough non-secret state to retry server confirmation. | `role="alert"`; focus the summary, then the retry action. | Retry only the future idempotent sign-out operation. A successful retry becomes `signed_out`; an unauthenticated result may also safely become `signed_out`. | Do not claim the server session ended, expose cookie/revocation internals, or offer account switching while status is unknown. |

## Minimal client/server state contract

### Client normalization

One boundary adapter owns transport-to-semantic mapping. Components consume the semantic state and safe copy; they never branch on provider query values, raw response bodies, or exception strings.

| Input class | Semantic result | Notes |
| --- | --- | --- |
| Trusted mode is `desktop` | Bypass all states in this artifact and mount the current desktop shell. | A desktop 401/403 is a local authorization/server problem, never a SaaS sign-in prompt. |
| SaaS `GET /api/session` returns reviewed 2xx allowlisted identity | `authenticated` | The current DHV-24 draft returns `{ user: { id } }`; the client may compare/type-check it internally but must treat the UUID as opaque and non-displayable. This does not authorize mounting business data until tenant-safe route composition exists. |
| SaaS probe returns minimal 401 | `sign_in_required` if no prior authenticated state; `session_ended` if the client previously held authenticated state | Missing, malformed, unknown, expired, and revoked remain indistinguishable. Do not inspect or request a reason. |
| Exact-Origin enforcement rejects a future state change with minimal 403 | `request_rejected` at the owning action, or `sign_out_unconfirmed` for sign-out | Copy says the request could not be completed and offers a safe reload/retry. Never redirect to sign-in or weaken Origin checks. `request_rejected` is an action error class, not a full-page identity state. |
| Probe returns 404/405, malformed success, unexpected content type, network/timeout, or 5xx | `service_unavailable` | Fail closed. A missing probe is not evidence that authentication is unnecessary. |
| Future provider handoff returns the normalized declined/cancel class | `sign_in_declined` | This reserves a semantic outcome, not a route or OAuth success claim. The future server adapter must discard provider detail. |
| Future callback validation returns the normalized invalid/replayed/expired-state class (typically client-error HTTP) | `callback_rejected` | This reserves a semantic outcome, not a callback URL or policy. All validation causes share one public result. |
| Future sign-out returns confirmed success or an already-unauthenticated result | `signed_out` | No URL, method, cookie attributes, or revocation policy is specified here; the owning security issue must define and test them. |
| Future sign-out gets network/timeout/5xx or an unrecognized response | `sign_out_unconfirmed` | Clear the local view but do not claim server revocation. |

All server error bodies crossing this boundary are allowlisted, low-cardinality classes such as `unauthorized`, `forbidden`, and a future normalized callback outcome. The UI owns public copy. It must not surface `error.message` from the current generic `api()` path.

### Fail-closed transition rules

1. SaaS starts at `session_checking`, never at `authenticated` from cached UI state.
2. Only a valid reviewed session-probe success can enter `authenticated`.
3. Any ambiguous or unsupported response becomes `service_unavailable`, not `sign_in_required` and not an empty product shell.
4. A 401 never triggers an automatic GitHub redirect. It hides protected content and requires a user action.
5. Callback decline and invalid state never enter `authenticated`, even if stale product data exists locally.
6. Sign-out confirmation is a user decision; after confirmation, the shell stays unavailable until `signed_out` or a fresh authenticated session is deliberately established.
7. No state may reveal whether another account, tenant, workspace, bot, invitation, or provider identity exists.

## Traceable implementation handoff

No implementation should begin from this artifact alone. The smallest likely client slice, after dependencies and review, is:

1. Add a pure session-state normalizer/reducer (likely `src/auth/session-state.ts` plus focused Vitest coverage) that accepts trusted mode and allowlisted response classes only.
2. Add one accessible `SessionBoundary` component with source/behavior tests for every inventory state, URL scrubbing, focus entry, draft clearing, and no sensitive-detail rendering.
3. Change `src/App.tsx` composition so explicit SaaS mode gates `StoreProvider`; preserve the current desktop composition byte-for-behavior where possible.
4. Add one request wrapper dedicated to the session probe with same-origin credentials and redacted errors. Do not route it through UI-facing raw `Error.message` behavior.
5. Keep `src/components/ConnectionExperience.test.ts` and `electron/api-auth.test.ts` as desktop regressions; add a test proving desktop mode never renders SaaS sign-in copy.
6. Add integration coverage that no snapshot, SSE, bot, group, routine, approval, computer, or workspace request starts while the SaaS boundary is unresolved or unauthenticated.

### Explicit DHV-24 dependency

The Founding Engineer must first deliver and independently review DHV-24's mode resolution, uniform invalid-session 401, exact-Origin protection, typed principal, and allowlisted probe. Before client integration, reconcile:

- how the trusted server/runtime mode reaches the renderer without a user-controlled switch;
- whether the reviewed probe shape remains `/api/session` and whether its internal UUID is necessary client-side;
- that SaaS mode still exposes no business route and never accepts desktop bearer or COMMS fallback;
- that health/probe errors are safe to normalize without exposing raw detail; and
- which later security-owned issue defines authorization start/callback and idempotent sign-out. This artifact intentionally defines no OAuth or sign-out route.

### Non-overlap with DHV-26

Do not edit or couple the client boundary to `server/db/migrations.ts`, `server/db/database.test.ts`, `server/repositories/index.ts`, `server/repositories/user-workspace-bindings.ts`, `server/repositories/user-workspace-bindings.test.ts`, or `docs/architecture/0007-user-workspace-binding-boundary.md`. DHV-26 owns persistence; the client must never accept or send a workspace owner/user ID. Later business routes must derive ownership exclusively from the reviewed server principal.

Implementation conflicts involving `src/App.tsx`/`StoreProvider` boot order, trusted mode delivery, DHV-24 response shape, or ownership of future auth routes escalate to the Founding Engineer.

## Product decisions, risks, and assumptions

### Chief of Staff decisions required before implementation

- **Authenticated label:** the safe default is generic “Signed in.” Adding GitHub login, display name, or avatar requires an explicit allowlist/product decision; the internal UUID is never acceptable UI copy.
- **Draft continuity after session end:** the safe default is to quarantine then clear unsent protected drafts unless same-authorized-context continuity is designed and reviewed. Restoring a prior user's draft after a different sign-in would be a cross-user leak.
- **Sign-out scope:** the safe default copy promises only this device/session. “Sign out everywhere” requires a separately approved server policy and UX.

Any choice that distinguishes invalid credential causes, weakens the exact-Origin/session gate, automatically falls back to a bearer, or reveals tenant/account existence must be escalated to the Chief of Staff and security/Founding Engineer; it is not an editorial variation.

### Risks and assumptions

- **Risk:** the current `StoreProvider` starts protected requests on mount. Putting a visual gate inside `Shell` would be too late and could fetch or flash tenant data.
- **Risk:** the current generic `api()` throws raw server messages. Reusing it directly could leak unstable technical detail and make components branch on transport strings.
- **Risk:** the DHV-24 draft probe exposes an internal UUID by design. Rendering or logging it would violate this UX boundary even if the server response remains allowlisted.
- **Risk:** local cache behavior is not yet specified. SaaS integration needs an explicit cache purge/partition test before protected data may be persisted client-side.
- **Assumption:** “GitHub” is the approved future handoff provider from the issue context, not an implemented capability or permission to choose scopes.
- **Assumption:** no tenant-safe business route is available at this stage, so `authenticated` may lead only to a bounded placeholder until separate route isolation is proven.

## Verification record

This is a documentation-only deliverable. Suitable verification is path existence, required-state coverage, whitespace hygiene, and a scoped diff/commit check:

```powershell
$artifact = 'docs/product/dhv-28-saas-sign-in-session-ux-contract-v1.md'
$evidence = @(
  'docs/product/dhv-7-primary-ux-state-audit-v1.md',
  'docs/architecture/0002-internal-user-session-boundary.md',
  'src/main.tsx',
  'src/App.tsx',
  'src/state/store.tsx',
  'src/components/ConnectionExperience.test.ts',
  'electron/api-auth.mjs',
  'electron/api-auth.test.ts',
  'electron/main.mjs',
  'electron/service-auth.mjs',
  'package.json'
)
$requiredStates = @(
  'session_checking', 'sign_in_required', 'sign_in_pending',
  'sign_in_declined', 'callback_rejected', 'session_ended',
  'service_unavailable', 'authenticated', 'sign_out_confirm',
  'sign_out_pending', 'signed_out', 'sign_out_unconfirmed'
)
$missingPaths = $evidence | Where-Object { -not (Test-Path $_) }
$text = Get-Content $artifact -Raw
$missingStates = $requiredStates | Where-Object { $text -notmatch [regex]::Escape($_) }
if ($missingPaths -or $missingStates) { throw 'DHV-28 static verification failed' }
git diff --check -- $artifact
git diff --name-only -- $artifact
git show --stat --oneline --name-only HEAD
```

No product code, server/auth route, persistence file, production data, secret, external provider, deployment, or paid service is changed by this artifact.
