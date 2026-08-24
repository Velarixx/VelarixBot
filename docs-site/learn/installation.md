# Installation

VelarixBot internal releases are distributed from the private `Velarixx/VelarixBot` repository. Releases are intentionally unsigned; verify every download against `SHA256SUMS.txt` published on the same release before installing.

## Verify the download

macOS:

```sh
shasum -a 256 ~/Downloads/VelarixBot-*.dmg
```

Windows PowerShell:

```powershell
Get-FileHash "$HOME\Downloads\VelarixBot-Setup-*.exe" -Algorithm SHA256
```

Compare the complete hash with the matching line in `SHA256SUMS.txt`. Trust only artifacts whose hash matches.

## macOS (Apple Silicon)

Use `VelarixBot-<version>-arm64.dmg`. Open the DMG and drag VelarixBot to Applications, then Control-click the app and choose **Open**, confirming past the unverified-developer warning. If the option is missing, launch once, then approve it under **System Settings → Privacy & Security → Open Anyway**. Do not disable Gatekeeper globally. If macOS still calls the app damaged after the hash checks out, remove quarantine from this exact app only:

```sh
xattr -dr com.apple.quarantine "/Applications/VelarixBot.app"
```

## Windows (x64)

Run `VelarixBot-Setup-<version>-x64.exe`. At the SmartScreen prompt choose **More info**, confirm the app name is VelarixBot, then **Run anyway**. The NSIS installer registers a per-user service named `velarixbot-harness` (never LocalSystem) that starts the harness with `--harness-service` so it can unseal secrets in your user session. Native dictation is unavailable on Windows; bots, the shared cloud computer, and local computer control all work.

## Engine sign-in

Bots run on agent CLIs you install and sign in separately: `claude`, `codex`, `grok`, and `gemini`. Install at least one and complete its login before creating bots — a bot whose engine is missing shows a setup card explaining exactly what to install. API-key engines (OpenRouter and compatibles) are configured in App Settings → Connections instead.

## Updating

The app checks the private release feed (App Settings → GitHub token) and updates in place from the update banner. Each release ships `SHA256SUMS.txt`; the in-app updater verifies the download, quits, and a helper replaces the installed app before relaunching. The UI reports success by reopening the new build, or an actionable error if install cannot finish.
