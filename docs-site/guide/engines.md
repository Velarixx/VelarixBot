# Engines

Every bot routes its turns to exactly one engine instance and model, chosen in the create modal or the header's model picker. Engines never share credentials with each other or with other bots' providers.

## Built-in CLI engines

| Engine | CLI | Transport | Auth |
| --- | --- | --- | --- |
| Claude Code | `claude` | native driver | CLI's own login |
| Codex | `codex` | native driver | ChatGPT/Codex OAuth (`~/.codex/auth.json`) |
| Grok | `grok` | ACP | `~/.grok/auth.json` |
| Gemini | `gemini` | ACP (`--experimental-acp`) | CLI's own login |

The harness detects each CLI on PATH, checks sign-in state, and publishes an availability snapshot per instance. Unavailable engines stay listed with the reason and are never silently substituted — a bot pointed at a missing engine gets a setup card, not a different provider.

## API engines

OpenRouter (and OmniRouter-compatible) instances are configured with an API key in App Settings → Connections. Keys are sealed in the OS keychain and referenced from config as `secret://` pointers; they are never written to config in plaintext and never shown again after saving.

## Model selection

New bots default to the first *available* engine (Codex preferred, then Claude). Each instance carries a model catalog with a marked default; switching models mid-thread is allowed and takes effect on the next turn.
