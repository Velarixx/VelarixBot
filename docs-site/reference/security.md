# Security model

**Loopback only.** The harness binds `127.0.0.1:8799` and nothing else. There is no LAN or tunnel mode; remote access is not a supported configuration today.

**Bearer token on every route.** All `/api/*` routes except `/api/health` require `Authorization: Bearer <token>`. The Electron main process injects the token into the harness it supervises; attach flows use a loopback-only sidecar bearer. A harness started with no token env mints a random one nobody holds — fail-closed.

**Secrets sealed, never echoed.** Keys live in the OS keychain, referenced from config as `secret://` pointers, shown once at entry, redacted from logs, and stripped from transcripts. `ask_secret` values bypass the thread entirely.

**Permission broker.** Tool calls are mediated per bot; hard categories always ask. Delegation grants no authority: target bots run under their own settings.

**Sign-ins stay off the chat.** Credential prompts are handed off to the bot's computer screen with explicit copy that passwords and codes are never typed in chat.

**Process identity.** The health `pid`/`stamp` contract prevents attaching to a stray or stale server on the port.

**No telemetry.** No analytics, no accounts, no cloud storage. Diagnostics export and verified backup/restore are local, manual, and behind the API token.
