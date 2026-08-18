# DHV-7 primary UX-state audit and navigation decision brief

- Version: 1.0
- Date: 2026-08-18
- Status: Review artifact; CEO selection required before implementation
- Owner: UX/Product Engineering
- Implementation integrator: Founding Engineer

## Scope and constraints

This artifact audits the primary VelarixBot product surfaces found in the current repository and defines a compact standard for empty, loading, error, blocked, and approval states. It also presents exactly two low-fidelity navigation/hierarchy proposals for CEO selection.

This is not a visual rewrite or an implementation plan approval. It does not change the accepted connection-state architecture in `docs/architecture/0001-explicit-ui-connection-state.md`, add an offline mutation queue, redesign secondary/admin surfaces, copy external branding or assets, or make pricing, target-customer, or broad platform decisions. All candidate implementation slices are deferred until the CEO selects a hierarchy and the Founding Engineer confirms integration sequencing.

## Evidence basis

### Discovery commands used

`rg` was attempted first but is not installed in this workspace. PowerShell discovery was used as the fallback:

```powershell
Get-ChildItem -Path docs\product,docs\architecture -Recurse -File | Select-Object -ExpandProperty FullName
Get-ChildItem -Path src -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\' } | Select-Object -ExpandProperty FullName
Select-String -Path src\App.tsx,src\components\*.tsx,src\state\store.tsx -Pattern 'export function|function Shell'
Select-String -Path <primary-files> -Pattern 'loading|error|No |empty|approval|approve|reject|blocked|permission|connect|failed|catch|pending|status|busy|disabled|denied|unavailable' -CaseSensitive:$false
git diff -- src/App.tsx src/components/Composer.tsx src/state/store.tsx src/state/store.test.ts src/components/ConnectionExperience.test.ts
```

### Files and surfaces inspected

| Evidence | What it establishes |
| --- | --- |
| `docs/product/dhv-5-baseline.md` | DHV-5 product gaps, sequencing, and the requirement for CEO-approved hierarchy before restructuring. |
| `docs/architecture/0001-explicit-ui-connection-state.md` | Accepted startup/reconnect semantics, draft preservation, server authority, and the explicit rejection of an offline mutation queue. |
| `package.json` | Available verification commands; no documentation-specific lint script exists. |
| `src/App.tsx` | There are no URL routes. `Shell` conditionally renders onboarding-independent workspace content, the selected bot/DM, global connection feedback, and panels/modals. |
| `src/state/store.tsx`, `src/state/store.test.ts` | Snapshot/SSE lifecycle, `connected`/`hasConnected`, transient global errors, bot state, queued sends, approvals, and primary panel state. |
| `src/components/ConnectionExperience.test.ts` | Delivered source-contract evidence for reconnect announcement and draft preservation. |
| `src/components/Onboarding.tsx` | First-run engine checks, optional microphone permission, skipped fetch errors, and skip paths. |
| `src/components/Sidebar.tsx` | Current conversation list, DMs, search, state badges, and footer entries for Routines, Skills, Apps, and App Settings. |
| `src/components/ChatView.tsx`, `src/components/Composer.tsx`, `src/components/OptionCard.tsx`, `src/components/ModelPicker.tsx` | Bot conversation, streaming, queued work, failed tools, blocked banner, approvals/questions/credentials, draft-safe offline behavior, and provider availability. |
| `src/components/GroupView.tsx` | Read-only bot-to-bot DM history and its empty/streaming/tool-result behavior. |
| `src/components/CreateBotModal.tsx` | Bot creation, model selection, portrait generation, validation, and current submission/error feedback. |
| `src/components/SettingsPanel.tsx` | Bot profile, memory/skills, permissions, approval rules, app access, destructive removal, and mixed save/error feedback. |
| `src/components/ComputerPanel.tsx` | Local/cloud computer phases, provisioning, permissions, busy ownership, cleanup confirmation, and teach/review/save states. |
| `src/components/RoutinesPanel.tsx` | Routine creation, run history, blocked runs, listener configuration, empty states, and failures. |
| `src/components/SkillsPanel.tsx` | Taught-skill library, recording state, edit/save/delete, bot enablement, and failures. |
| `src/components/PluginsPanel.tsx` | Apps catalog, search, sessions, connect/OAuth, per-bot enablement, configuration blockers, and failures. |
| `src/components/AppSettingsPanel.tsx`, `src/components/ApiKeys.tsx`, `src/components/UpdateBanner.tsx` | Workspace credentials/settings, per-row saving, diagnostics/backup, update feedback, and app-level update notices. |

### Current hierarchy

The application is a single shell rather than a URL-routed product:

```text
Shell
|-- Sidebar
|   |-- New bot + search
|   |-- Bots
|   |-- Direct messages
|   `-- Routines / Skills / Apps / App Settings
|-- Main: selected Bot chat OR selected Direct message OR no-bots/connecting state
|-- Right panel: Bot Settings / Computer / App Settings / Routines / Skills
|-- Modal: Apps / Create bot
`-- Overlay: first-run Onboarding
```

The primary surfaces are therefore the first-run gate, workspace shell/navigation, bot conversation, bot-to-bot DM, create-bot flow, and the five user-facing work/configuration panels. `ApiKeys`, `ModelPicker`, approval cards, composer, and update banner are audited as state-bearing parts of those surfaces rather than promoted to independent navigation destinations.

## Reusable state standard

Use these semantics in existing components; a new platform or route framework is not required.

| State | Trigger and meaning | Copy pattern | Primary action | Recovery and persistence | Accessibility expectation |
| --- | --- | --- | --- | --- | --- |
| Empty | A successful load returned no objects, no results match a user filter, or the user has not created the first object. Empty is not failure. | Name the absence, then the value of the next step: “No routines yet. Create one to run a prompt on a schedule.” Search empties should echo the query category, not imply data loss. | One direct creation/clear-filter action when one exists. | Stay until the collection/filter changes. Never replace a known load error with empty. | Use a visible heading or meaningful sentence; focus stays on the triggering control. The CTA must have a text name. |
| Loading | Initial data is unresolved, an explicit mutation is pending, or a long-running operation is progressing. Existing usable content should remain when safe. | Verb + object: “Loading run history…” / “Creating bot…” Avoid transport jargon and indefinite “Working” when the object is known. | Usually none; offer Cancel/Stop only when supported and safe. Disable only controls that would duplicate or conflict with the pending action. | On success, preserve context and announce completion where it is not visually obvious. On failure, transition to Error, never Empty. | For updates lasting beyond a brief button press, use `role="status"` or `aria-live="polite"`; decorative spinners are hidden or paired with text. Do not move focus on background refresh. |
| Error | A request, local bridge call, or operation failed unexpectedly. The user may retry or choose another path. | Human summary first, retained detail second: “Couldn’t load routines.” Avoid raw status/transport text as the only message. | “Try again” at the failing scope; use “Open settings” only when configuration is the known fix. | Keep prior content/drafts and the error until retry, dismissal, or success. A timed global banner may supplement but must not be the only feedback for modal/panel work. | Use `role="alert"` for a newly failed user action; focus the error summary on failed form submission. Associate field errors with inputs. |
| Blocked | A known prerequisite, policy, permission, ownership conflict, offline condition, or agent state prevents the next action. This is not an unexpected failure. | State what is blocked, why, and what remains safe: “Connection lost. Reconnecting — drafts stay here until you can send.” | Route to the prerequisite, such as “Open Settings,” “Add key,” “View bot,” or “Try again” after reconnection. | Preserve user input. Auto-resume only when behavior is already defined (for example SSE reconnect); otherwise require an explicit retry. Do not broaden offline mutation behavior beyond ADR 0001. | Announce state transitions politely unless immediate action is required. Disabled controls need adjacent visible reason, not tooltip-only explanation. Do not rely on color/badges alone. |
| Approval | A live agent/provider request needs human allow/deny/input, or an irreversible/high-impact action needs explicit confirmation. It is a deliberate decision, not a generic error. | Identify actor, action, scope, and consequence. Distinguish “Allow once,” bot-scoped persistence, and workspace scope. Secret copy must say it stays out of the transcript. | Two explicit choices with safe default; keep advanced persistent scope visually secondary. | Keep the request visible while submitting, show pending state, then show the recorded outcome. Failed responses must return to an actionable card without losing typed input. | Use a named group/dialog as appropriate; focus the decision heading when it appears; buttons need unambiguous names; close/dismiss must have an accessible name and equivalent denial semantics must be clear. |

### Cross-surface presentation rules

1. Keep state feedback at the scope that owns recovery: button for a mutation, card/panel for a collection, shell for connectivity.
2. Prefer one summary plus one action. Technical detail can be secondary and selectable, but never the only copy.
3. Preserve drafts, filters, scroll position, and successfully loaded content through loading, error, and blocked states whenever safe.
4. Never map `catch` to an empty array without separately recording load success/failure.
5. Status color and icon supplement text. Every state must remain understandable without color or animation.
6. Background refresh uses polite announcements; failed user-initiated actions use alerts. Focus changes only for opened dialogs, submitted form errors, or a user-selected destination.
7. The delivered connection notice remains app-scoped, distinguishes initial connection from reconnection, and keeps the composer editable but non-dispatching. Other offline mutations remain unchanged until separately designed and approved.

## Primary-surface inventory and traceability

Legend: **Covered** means a recognizable current state exists; **Partial** means the state exists but lacks clear copy, recovery, persistence, or accessibility; **N/A** means the state is genuinely not part of that surface’s responsibility.

| Primary surface | Empty | Loading | Error | Blocked | Approval |
| --- | --- | --- | --- | --- | --- |
| First-run onboarding (`Onboarding`) | **N/A:** fixed setup steps, not a user collection. | **Covered:** “Checking…” while engine instances load. Permission polling has no distinct pending copy. | **Partial:** instance fetch failure becomes an empty list and is shown as every engine “Not found”; permission errors are swallowed; neither has Retry. | **Covered:** missing/unauthenticated engines include install/sign-in guidance; denied mic offers Open Settings; setup remains skippable. | **Covered:** OS mic permission is requested only from Enable, with Open Settings/Skip alternatives. |
| Workspace shell and sidebar (`Shell`, `Sidebar`) | **Partial:** no-bots state has explanation + Create a bot; a zero-result search has no message or Clear search. | **Covered:** initial connection and persistent connecting/reconnecting messages are distinct; hydrated content remains visible. | **Partial:** store errors appear only inside `ChatView`, expire after six seconds, and can be hidden by another panel/modal. | **Covered within ADR scope:** offline banner + editable, non-sending composer preserve the draft. Other mutations remain intentionally unchanged. Bot BLOCKED/NEEDS INPUT badges are visible but not actionable from the list. | **N/A:** the shell should surface/link decisions, not ask for authority itself. |
| Bot conversation and composer (`ChatView`, `Composer`, `OptionCard`, `ModelPicker`) | **Partial:** a bot with no messages renders blank conversation space with no first-turn guidance. | **Covered:** busy badge, working timer, stream, tool spinner, computer provisioning, and queued prompts; most are not live-announced. | **Partial:** transient global banner and failed-tool icon exist, but there is no scoped retry and failures can disappear. | **Partial:** “Bot is blocked” + server detail is explicit but supplies no recovery action; offline send guard follows ADR 0001. | **Covered/Partial:** permission, question, credential, secret, suggestion, and setup cards preserve scope choices; submission has no pending feedback, failures use the transient global error, and the dismiss icon lacks an accessible name. |
| Bot-to-bot direct message (`GroupView`) | **Covered:** “Messages between these bots appear here.” | **Partial:** streaming/tool progress is visible but not announced. | **Partial:** a failed tool gets an X/color only; no summary or source-bot recovery link. | **N/A:** this is a read-only mirror; blocking belongs to the source bot conversation. | **N/A:** decisions belong to the source bot’s live request card. |
| Create bot (`CreateBotModal`, `ModelPicker`) | **N/A:** blank fields are form input, not an empty dataset. | **Partial:** portrait generation says “Generating…”; Create becomes disabled but does not say “Creating…” or announce completion. | **Partial:** portrait errors stay inline; create failure is routed to the transient chat error and may be obscured by the modal. | **Partial:** missing name disables Create; unavailable providers expose reasons in ModelPicker, but the form has no panel-level “choose/install a provider” recovery. | **N/A:** creation is a direct user action; no agent authorization is being requested. |
| Bot settings (`SettingsPanel`) | **Covered:** explicit empty copy exists for skills, approval rules, and app catalog. | **Partial:** portrait generation has feedback; initial skills/rules/apps reads and autosaves mostly have no pending/saved state. | **Partial:** portrait generation is inline, but several reads/writes silently catch or depend on the transient chat error. | **Covered/Partial:** missing image key and last-bot removal explain the prerequisite; recovery links/actions are inconsistent. | **Covered:** Require approval, Always allow, bot/workspace rule scope, quarantined-rule re-enable, and remove-bot confirmation are explicit. Some persistence failures are silent. |
| Bot computer and teach task (`ComputerPanel`) | **Covered:** off, unconfigured, unavailable, no-frame, and no-old-box states are distinct. | **Covered:** checking, starting, capture, join/sleep, cleanup, and teach operations use text/spinners. | **Partial:** inline error is retained, but generic reachability errors lack a scoped Retry and some polling/screenshot failures are suppressed. | **Covered:** missing Box token, unsupported local mode, screen permission, shared-computer occupancy, and off state explain why work cannot proceed and usually provide a path. | **Covered:** destructive old-box cleanup confirms scope; taught tasks have reviewable Save/Discard; OS permission handoff is explicit. |
| Routines (`RoutinesPanel`) | **Covered:** “No routines yet” and “No runs yet” are distinct. | **Partial:** run history, create, and test show progress; initial routine load has no loading state and can momentarily look empty. | **Partial:** panel mutations show inline error; history failure becomes `[]`, incorrectly showing “No runs yet.” | **Partial:** blocked run status/result and local-scheduler constraints are visible, but there is no action to the affected bot/prerequisite. | **N/A:** routine execution approvals appear as bot request cards. Routine delete is immediate and should be reviewed as a destructive-confirmation gap, not an agent approval state. |
| Skills (`SkillsPanel`) | **Covered:** the library explains that a computer recording creates the first skill. | **Partial:** row save spinner exists; initial skills/sessions load has no loading state. | **Partial:** skill failure shows inline; teach-session fetch failure is silent and indistinguishable from none. | **Partial:** “Deleted bot” identifies an orphan but gives no reassignment/removal path. | **N/A:** this surface has no agent request. Skill deletion is immediate and should be reviewed as a destructive-confirmation gap. |
| Apps (`PluginsPanel`) | **Covered:** no catalog, no matches, and no sessions have separate copy. | **Covered:** catalog, connect/disconnect, refresh, session create/revoke show progress, though not live-announced. | **Partial:** catalog/action errors are inline; status and sessions refresh failures are swallowed, leaving possibly stale/empty state. | **Covered/Partial:** unconfigured Composio routes to App Settings; missing bot/config disables controls, but sessions-disabled rationale is not adjacent. | **Covered:** OAuth/connect page is an explicit external handoff. Connection scope is explained; response state after external completion relies on polling. |
| App settings (`AppSettingsPanel`, `ApiKeyRow`, `UpdateBanner`) | **N/A:** this is fixed configuration content; environment-specific rows are intentionally absent when unsupported. | **Covered/Partial:** save, backup/export, and update operations label progress; initial desktop bridge reads have no pending state. | **Partial:** key/CLI/shared-box/update failures are inline; diagnostics success and failure share neutral styling, and some bridge writes lack failure feedback. | **Partial:** unavailable desktop-only capabilities are hidden rather than explained; disabled unchanged/saving controls generally rely on context. | **N/A for agent requests:** secret entry is explicit and write-only. Security-sensitive shared-computer and app-update actions are direct settings choices, not provider approvals. |

### Highest-impact standardization gaps

1. **Failure is sometimes rendered as empty.** Onboarding engine load and routine history are the clearest cases; Skills and Apps also swallow secondary fetch errors.
2. **Recovery is inconsistent.** Chat blocked/error banners, create-bot failure, and computer reachability do not offer a local retry or prerequisite action.
3. **Panel mutations are under-reported.** Many Settings writes and several bridge calls fail silently or through a chat-only timed banner.
4. **Approval response state is incomplete.** The decision content and scope are strong, but cards do not show submit progress or an inline retry, and dismiss lacks an accessible name.
5. **Primary navigation mixes three object levels.** Conversations, reusable automation assets, external connections, and app-wide settings are visually peers in one undifferentiated footer.

## Navigation/hierarchy proposal 1: Conversation-first with grouped utilities

### Low-fidelity wireframe

```text
+----------------------+-------------------------------+------------------+
| + New bot   Search   | Selected bot or DM            | Context panel    |
|                      |                               | (when opened)    |
| CONVERSATIONS        | Header: bot / state / model   |                  |
|   Bot A              |                               | Bot settings     |
|   Bot B              | Conversation + approvals     | or Computer      |
|   Direct messages    |                               |                  |
|                      | Composer                      |                  |
| AUTOMATE             |                               |                  |
|   Routines           |                               |                  |
|   Skills             |                               |                  |
| CONNECT              |                               |                  |
|   Apps               |                               |                  |
|----------------------|                               |                  |
| App Settings         |                               |                  |
+----------------------+-------------------------------+------------------+
```

### Rationale

This formalizes the product’s current center of gravity: a user selects a bot, chats, responds to inline requests, and opens bot-specific settings/computer in context. Section labels clarify the existing footer without changing the object model.

### Preserved workflows

- New bot from the sidebar, composer, slash command, or no-bots state.
- Direct bot selection, search, pinned bots, unread markers, and bot-to-bot DM selection.
- Inline approval/credential/question cards in their originating conversation.
- Bot header access to model, Settings, and Computer.
- Direct access to Routines, Skills, Apps, and App Settings.

### Tradeoffs and risks

- Lowest navigation migration and implementation risk.
- Keeps conversation context dominant and contextual panels close to the selected bot.
- Cross-bot approvals and blocked work can remain buried in individual conversations; badges need stronger text/action semantics.
- Long bot lists still compete vertically with utility destinations.
- Right-panel stacking/precedence remains a source of implementation conflicts unless one-open-panel behavior is formalized.

### Migration impact

- Group and label existing sidebar destinations; no new route system is required.
- Preserve current component ownership and open/close actions.
- Add state counts/labels only from existing bot/card data; do not introduce a new approval service.
- The Founding Engineer can integrate this as a narrow shell/sidebar slice after selection.

## Navigation/hierarchy proposal 2: Attention-first workspace with task hubs

### Low-fidelity wireframe

```text
+----------------------+-------------------------------+------------------+
| + New bot   Search   | Selected destination          | Context panel    |
|                      |                               | (when opened)    |
| NEEDS ATTENTION      | Needs attention:              |                  |
|   Approvals (n)      |   approval links -> source    | Bot settings     |
|   Blocked (n)        |   blocked links -> source     | or Computer      |
|                      |                               |                  |
| CONVERSATIONS        | OR selected conversation      |                  |
|   Bot A              |   messages + inline request   |                  |
|   Bot B              |   composer                    |                  |
|   Direct messages    |                               |                  |
|                      | OR selected hub               |                  |
| WORKSPACE            |   Automations: Routines/Skills|                  |
|   Automations        |   Connections: Apps           |                  |
|   Connections        |                               |                  |
|----------------------|                               |                  |
| Settings             |                               |                  |
+----------------------+-------------------------------+------------------+
```

“Needs attention” is an index of existing unanswered cards and existing `BLOCKED` bot states. Selecting an item opens its source conversation; the live card and response semantics remain inline. It is not a new workflow engine, shared inbox, or approval backend.

### Rationale

This makes human decisions and stalled agent work visible before the user chooses a bot. Routines/Skills and Apps are grouped as task hubs, reducing the number of peer destinations while preserving their existing components.

### Preserved workflows

- Every conversation, inline request card, composer, model choice, bot settings, and Computer workflow remains available.
- Existing Routines and Skills become two views within Automations; existing Apps becomes Connections.
- Selecting an attention item deep-links/selects its current bot; it does not duplicate or move the approval.
- App settings remains globally scoped and separate from bot settings.

### Tradeoffs and risks

- Makes pending decisions and blocked work discoverable across bots.
- Provides clearer conceptual grouping as Routines, Skills, and Apps grow within their current scope.
- Requires derived attention counts, a selected top-level destination, and empty/loading/error states for the index; this is materially more shell/state work than Proposal 1.
- “Attention” can over-emphasize warnings and create count drift if derived from partially hydrated card history.
- Combining Routines/Skills under one hub and renaming Apps to Connections may reduce direct recognition for current users.

### Migration impact

- Add a thin attention index derived only from existing hydrated bot/card state; source conversations remain authoritative.
- Add top-level destination selection to the current shell or a minimal route abstraction; do not replace the store/SSE architecture.
- Wrap, rather than rewrite, Routines/Skills and Apps components in hub navigation.
- Requires a bounded hydration/count contract and Founding Engineer feasibility review before UI work.

## CEO decision prompt

| Decision dimension | Proposal 1: Conversation-first | Proposal 2: Attention-first |
| --- | --- | --- |
| Primary orientation | Pick a bot, then act | See required human action, then choose source/context |
| Change from current shell | Low | Moderate |
| Cross-bot approval/blocked discoverability | Relies on strengthened list badges | Dedicated derived index linking to source |
| Utility hierarchy | Three labeled groups with direct destinations | Two workspace hubs plus global Settings |
| State/data work | Mostly presentation and scoped state standardization | Adds index selection, counts, and its five states |
| Main risk | Important work remains conversation-scoped and easy to miss | Attention counts/hub abstraction add complexity and may dominate the experience |

**CEO decision requested:** select **Proposal 1 (Conversation-first with grouped utilities)** or **Proposal 2 (Attention-first workspace with task hubs)** as the hierarchy direction. This brief intentionally does not select one. Any requested hybrid or scope change should return to the Chief of Staff for a revised decision brief before implementation.

## Deferred implementation handoff

No slice below is authorized until the CEO selection is recorded. After selection, the Founding Engineer should own integration and may sequence these bounded candidates independently:

1. **State primitive contract:** a small existing-style notice/empty component plus copy and accessibility tests; no visual-system rewrite.
2. **Load-vs-empty correctness:** onboarding engine check and routine history, each retaining its current API and adding explicit Retry.
3. **Conversation recovery:** scoped chat error/blocked actions and approval-card submitting/retry/accessibility, preserving request-response APIs and ADR 0001.
4. **Panel request feedback:** one panel at a time (Skills, Apps, then Settings), replacing swallowed failures with local state without centralizing all mutations.
5. **Selected navigation shell:** either sidebar grouping for Proposal 1 or the derived attention index/hub selection for Proposal 2, never both.

Implementation conflicts to escalate to the Founding Engineer include one-open-panel precedence, whether modal errors can safely reuse `state.error`, and any requested offline behavior beyond composer send. Product choices, proposal selection, naming changes, or hybrid hierarchy requests escalate to the Chief of Staff/CEO.

## Risks and assumptions

- **Assumption:** “primary” means first-run, conversation, creation, bot context, automation assets, connections, and app-wide settings reachable from `Shell`/`Sidebar`; diagnostics, updater internals, and individual key rows are dependencies within App Settings, not separate primary destinations.
- **Assumption:** bot-to-bot DMs remain read-only mirrors and approvals remain authoritative in their source bot conversation.
- **Risk:** several errors are raw server messages; standardizing presentation without a small error-code/copy map may expose inconsistent or technical copy.
- **Risk:** the current six-second global error timeout can conceal failures behind panels and modals.
- **Risk:** direct deletes in Routines and Skills do not follow the approval/confirmation standard and need product confirmation on undo versus confirm before implementation.
- **Risk:** Proposal 2 attention counts can be wrong during partial hydration unless the Founding Engineer defines a bounded derivation contract.
- **Constraint:** concurrent DHV-5/DHV-6 work owns the current connection-state changes. This audit does not modify those files.

## Verification record

The smallest relevant check is static artifact verification because this change is Markdown only and the repository has no documentation lint/link script. Verification should confirm whitespace, evidence-path existence, and that the decision brief contains exactly two proposal headings:

```powershell
git diff --check -- docs/product/dhv-7-primary-ux-state-audit-v1.md
$evidence = @(
  'docs/product/dhv-5-baseline.md',
  'docs/architecture/0001-explicit-ui-connection-state.md',
  'src/App.tsx',
  'src/state/store.tsx',
  'src/components/ConnectionExperience.test.ts',
  'src/components/Onboarding.tsx',
  'src/components/Sidebar.tsx',
  'src/components/ChatView.tsx',
  'src/components/Composer.tsx',
  'src/components/OptionCard.tsx',
  'src/components/GroupView.tsx',
  'src/components/CreateBotModal.tsx',
  'src/components/SettingsPanel.tsx',
  'src/components/ComputerPanel.tsx',
  'src/components/RoutinesPanel.tsx',
  'src/components/SkillsPanel.tsx',
  'src/components/PluginsPanel.tsx',
  'src/components/AppSettingsPanel.tsx'
)
$missing = $evidence | Where-Object { -not (Test-Path $_) }
$proposalCount = (Select-String -Path docs/product/dhv-7-primary-ux-state-audit-v1.md -Pattern '^## Navigation/hierarchy proposal [12]:' -CaseSensitive).Count
if ($missing.Count -gt 0 -or $proposalCount -ne 2) { throw "Static verification failed" }
"PASS: 18 evidence paths exist; exactly 2 proposal headings found."
```

No product code, generated asset, production data, secret, deployment, or paid service is touched by this artifact.
