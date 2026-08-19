# DHV-43 authenticated bot creation UX evidence

Status: review artifact recorded before implementation. This document does not approve a broader visual rewrite or select a future navigation proposal.

## Inspected surfaces and contract evidence

- `src/App.tsx`: SaaS mode renders `SessionBoundary` and `CatalogShell`; desktop mode alone renders `StoreProvider` and `CreateBotModal`.
- `src/auth/SessionBoundary.tsx`: owns the existing session-loss and sign-out paths, including sign-out focus restoration.
- `src/saas/CatalogShell.tsx`: authenticated loading, empty, populated, error, and cleared-on-auth-loss states; currently labels the catalog read-only.
- `src/saas/catalog-state.ts`: ephemeral display-projection reducer with stale-load suppression.
- `src/saas/catalog-transport.ts`: bounded `GET /api/bots?messages=0` transport that retains only name, title, description, and color.
- `server/routes/saas-bot-catalog.ts` at reviewed commit `e097196`: quota-bound `POST /api/bots` accepts only `{}`, returns 201, uses 401 for lost auth and 409 for quota. Inspected as contract evidence only; it remains server-owned and unmodified.
- Existing focused suites in `src/saas/*.test.ts` and SaaS/desktop composition assertions in `src/auth/mode.test.ts` and `src/auth/SessionBoundary.test.ts`.

## State inventory and interaction contract

| State | Protected display data | Primary action | Announcement / focus |
| --- | --- | --- | --- |
| Initial loading | None | Sign out only | Polite loading status; shell busy |
| Empty | Empty projection | Create first bot | Existing deterministic result heading focus |
| Populated | Existing display projection only | Create bot | Loaded count announced |
| Creating | Existing display projection only | Creation controls disabled | Polite progress status |
| Refetching after 201 | Existing display projection only | Creation controls disabled | Polite progress status; only bounded GET may replace projection |
| Created | Fresh display projection only | Create bot | Polite success status receives focus |
| Quota reached | Existing display projection only | Retry not offered | Generic assertive status receives focus |
| Retryable create failure | Existing display projection only | Try again | Generic assertive status receives focus |
| Retryable refetch failure | Existing display projection only | Try again (GET only) | Generic assertive status receives focus; POST is not repeated |
| Catalog error | None | Try again (GET) | Existing assertive error and deterministic focus |
| Auth lost | None | Existing session path | Protected state cleared before parent transition |

The POST response is bounded and checked for valid JSON, then discarded. A 201 is not displayed as success until a fresh bounded catalog GET completes. No caller identity or bot/provider/computer/workspace/model fields are accepted by the create transport.

## Exactly two low-fidelity navigation / hierarchy proposals for CEO selection

These are future product hierarchy options, not implementation approval. DHV-43 keeps the current single-page catalog shell and adds only the acceptance-required reversible controls.

### Proposal 1: Catalog-first shell

```text
SaaS
â””â”€ Bot catalog
   â”œâ”€ Page action: Create bot
   â”œâ”€ Feedback region
   â””â”€ Catalog grid / first-bot empty state
```

Rationale: lowest navigation cost while the authenticated SaaS product has one primary resource. It defers global navigation until another durable destination exists. Risk: page-level actions can become crowded as bot management grows.

### Proposal 2: Resource navigation shell

```text
SaaS
â”œâ”€ Bots (selected)
â”‚  â”œâ”€ Collection action: Create bot
â”‚  â””â”€ Catalog grid / first-bot empty state
â””â”€ Account
   â””â”€ Sign out
```

Rationale: establishes a scalable separation between resource work and account actions. Risk: adds hierarchy and navigation weight before a second authenticated resource workflow has been approved.

Product choice owner: Chief of Staff / CEO. Neither proposal changes the narrow DHV-43 implementation. Any integration conflict in the existing shell, session boundary, or shared composition belongs with the Founding Engineer.

## Assumptions, risks, and verification

- Assumption: the reviewed `e097196` POST contract remains unchanged pending DHV-42 approval.
- Assumption: creation uses server defaults only; naming, provider/model selection, workspace binding, chat, and editing are out of scope.
- Risk: a POST may commit while its response or follow-up GET fails. The client therefore retries only the GET after a known 201, preventing accidental duplicate creation.
- Risk: concurrent DHV-42 review may require contract changes before delivery-ready status.
- Verification: focused transport, reducer/coordinator, and shell suites; SaaS composition isolation assertions; client TypeScript/build checks; `git diff --check`; final diff audit against the seven server-owned files.
