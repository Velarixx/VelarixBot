# Roadmap

The near-term direction, in build order. Details live in the internal development plan.

**Durable wakeup queue.** A SQLite-backed queue (queued/claimed/done, idempotency keys, coalescing, orphan-run recovery) under the background harness, driving routines, delegations, nudges, and work items — exactly-once across restarts.

**Cost tracking & budget policies.** Real per-turn usage events per engine, spend shown per bot and per project, and budget policies (monthly caps, 80% warning, hard stop) that pause a scope with an incident card instead of letting work run away.

**Projects.** Grok Bot-style sidebar folders that own a coordination thread, a budget scope, and an autonomy policy. Bots coordinate in the project thread with bounded context projection.

**Work items.** First-class tasks with owners, statuses, blockers, and atomic checkout locking, so "assigned / running / blocked" are rows with handoff receipts, not chat text.

**Autonomy policy.** Per-project `supervised` vs `autonomous`: autonomous projects pre-allow coordination and work-item tools while hard categories, per-bot restrictions, and budget stops keep asking. A project cannot go autonomous without an active budget policy.

**Head-bot orchestration.** The Chief of Staff pattern promoted: plan a goal into work items, dispatch to owners, review the board on a schedule, and escalate judgment calls as decision cards.
