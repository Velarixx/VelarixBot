# Configuration

Everything lives under `~/.velarixbot`.

| Path | Contents |
| --- | --- |
| `config.json` | App configuration. API keys and tokens appear only as `secret://` references; plaintext keys found on boot are migrated into the secret store automatically. |
| `velarixbot.db` (SQLite) | Bots, threads, messages, routines, memory rows, skills metadata. |
| `memory/` | Per-bot and workspace markdown memory. |
| `blobs/` | Content-addressed files: screenshots, avatars, attachments. |

## Environment variables

`VELARIX_API_TOKEN` — inject the API bearer token (used by the Electron main process and the service).

`VELARIX_DEV_TOKEN` — dev-run token for `pnpm dev:server`. Without either variable the harness mints a random token that nothing holds, so an unauthenticated harness is unreachable by design.

## Secrets

Secrets seal into the OS keychain (macOS Keychain, Windows `safeStorage` in your user session). Config and logs never contain secret values; log lines are redacted before writing. Headless environments without a keychain read as *not configured* rather than falling back to plaintext.

## Instances

Additional engine instances (extra OpenRouter-compatible providers) are declared in `config.json` under `instances`, each with a base URL, a `secret://` key reference, and a model list.
