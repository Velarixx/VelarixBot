# Memory

Each bot remembers two ways.

**Markdown memory** — a per-bot note (`~/.velarixbot/memory/<botId>.md`) plus a shared workspace note, both editable in the bot's memory panel. After a successful turn the bot distills what changed into the note.

**Structured rows** — typed entries (**preference**, **fact**, **workflow**) in SQLite. At turn start the most relevant rows (BM25-ranked, top 10) are injected under the heading *"What you know about this user."* Rows bump a use count when injected and decay when idle; pinned rows never decay. Extraction only *suggests* rows — cards write on accept, so nothing enters memory without you seeing it.

Repeated **workflow** rows drive proactivity: a workflow the bot keeps extracting becomes a suggestion card — "Want me to make this a routine?" — which creates a real routine on accept.

Memory is per bot by design. There is no shared group memory and no ambient cross-bot learning. Edit, pin, delete, or wipe everything per bot from the memory panel. No embeddings and no cloud are involved.
