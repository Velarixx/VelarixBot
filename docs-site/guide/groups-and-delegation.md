# Groups & delegation

Shipped coordination is one-to-one: A⇄B sidebar DMs plus bot-to-bot tools. There is no group room, no group thread, no bulletin, and no voice.

## Bot-to-bot asks and delegation

Bots can consult or hand work to each other with `ask_bot` (a question, answer returns to the asker) and `delegate_bot` (a task the target runs as its own turn). Delegation is protected by cycle detection, depth limits, concurrency caps, and busy-queueing, so delegation trees terminate and a busy bot queues rather than drops.

The target bot always runs under its **own** engine, model, apps, credentials, computer, and permission settings. Delegation never inherits the initiator's authority.

## Chief of staff

The seeded Chief of Staff bot is a coordinator pattern: give it a goal and let it consult and delegate to specialists. Project folders with coordination threads, work-item boards, and per-project autonomy policies are on the roadmap — see [Roadmap](/reference/roadmap).
