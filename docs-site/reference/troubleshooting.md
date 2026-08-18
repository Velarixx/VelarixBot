# Troubleshooting

## A bot is blocked with "CLI not found"

The bot's engine isn't installed or isn't on PATH for the harness. Install the CLI (`claude`, `codex`, `grok`, or `gemini`) or switch the bot's model from the card. GUI-launched apps see a different PATH than your shell; the harness augments PATH, but nonstandard install locations may need a shell-profile export.

## Codex: "refresh token was already used"

OpenAI rotates refresh tokens; each is single-use. Two sessions refreshing the same `~/.codex/auth.json` invalidate the pair. Fully quit VelarixBot (tray too), stop any stray harness process, run the Codex logout/login flow in a terminal, and relaunch. Avoid running `codex` in a terminal while many bots are active on the same account. The app maps this state to a sign-in card (`auth_required`) rather than a raw error.

## The updater keeps offering the same version

Confirm the installed app really updated (About shows the version) and that your GitHub token in App Settings can read the private release feed. Verify the release's `SHA256SUMS.txt` matches what you downloaded.

## Two servers on port 8799

Only one harness may own the store. `GET /api/health` shows the pid of whichever process holds the port; if it isn't the service or the app, stop that process. The app attaches to a healthy current harness instead of starting a second.

## Routines didn't run overnight

Without the background service, routines run only while the app is open — install the service from App Settings. With it, check the missed-run policy: `skip` drops missed fires by design, while `once` coalesces them into a single run on resume.

## Where is my data?

Everything is under `~/.velarixbot`. Diagnostics export and verified backup/restore live in App Settings and operate entirely locally.
