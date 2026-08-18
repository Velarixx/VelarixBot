# DHV-5 product baseline

Date: 2026-08-18

## Observed foundation

Velarixbot is already a substantial local-first desktop/web application. The
repository includes bot and group chat, multiple agent drivers, human approval
cards, per-bot connected-app permissions, resumable event streaming, audit/event
repositories, diagnostics, backup/export paths, and a broad automated test suite.

## Highest-impact gaps

1. **Connection feedback and recovery.** A hydrated workspace can appear usable
   after the event stream disconnects. DHV-5 addresses the first slice by making
   the state visible and preserving composer drafts.
2. **Core-journey browser coverage.** Most client tests are unit or source-contract
   tests. A deterministic end-to-end path should cover onboarding bypass, bot
   creation, sending, approval, failure recovery, and restart hydration.
3. **Product hierarchy consistency.** Settings, Apps, Skills, Routines, Computer,
   bots, and groups are all implemented, but the primary workflow and navigation
   hierarchy need CEO-approved prioritization before substantial redesign.
4. **Release confidence.** The suite is broad, but a release acceptance matrix and
   a small set of cross-platform smoke checks should define what “finished” means.

## Recommended next reviewable increments

1. Add a deterministic Playwright smoke journey backed by the existing fake
   engine/harness (recommended first).
2. Audit and standardize empty, loading, error, blocked, and approval states across
   every primary surface.
3. Produce two low-fidelity navigation/hierarchy proposals from the existing
   feature set for CEO selection before visual restructuring.
4. Define release gates for Windows, macOS, auth, backup/restore, and interrupted
   agent turns; then automate only the highest-risk gaps.

## Explicit boundary

This baseline does not select a target customer, pricing, product strategy, or a
general-purpose multi-tenant platform. “Like Paperclip” is treated as a quality
bar for legibility, feedback, and smooth workflows—not permission to copy its
branding, assets, or unapproved product scope.
