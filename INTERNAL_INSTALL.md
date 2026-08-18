# Installing an internal VelarixBot release

VelarixBot releases in this private repository are intentionally unsigned. Only install an artifact you downloaded from `Velarixx/VelarixBot` and whose SHA-256 hash matches `SHA256SUMS.txt` on the same release.

## Verify the download

macOS:

```sh
shasum -a 256 ~/Downloads/VelarixBot-*.dmg
```

Windows PowerShell:

```powershell
Get-FileHash "$HOME\Downloads\VelarixBot-Setup-*.exe" -Algorithm SHA256
```

Compare the complete hash with the matching line in `SHA256SUMS.txt`.

## macOS

macOS releases are Apple Silicon (arm64) only. Use `VelarixBot-<version>-arm64.dmg`.

1. Open the downloaded `.dmg` and drag VelarixBot to Applications.
2. In Finder, Control-click `/Applications/VelarixBot.app` and choose **Open**.
3. Confirm **Open** when macOS warns that the developer cannot be verified.
4. If that option is not shown, try opening the app once, then open **System Settings → Privacy & Security**, find the VelarixBot notice, and select **Open Anyway**.

Trust only this VelarixBot copy. Do not disable Gatekeeper globally. Local computer control and dictation can produce separate macOS permission prompts; approve only the features you intend to use.

If macOS still reports that the app is damaged after you have verified the hash, remove quarantine only from this exact app:

```sh
xattr -dr com.apple.quarantine "/Applications/VelarixBot.app"
```

## Windows

1. Run `VelarixBot-Setup-<version>-x64.exe`.
2. If Microsoft Defender SmartScreen shows **Windows protected your PC**, select **More info**.
3. Confirm that the app name is VelarixBot, then select **Run anyway**.
4. Complete the installer.

Do not disable SmartScreen or Microsoft Defender globally. Windows supports bots, the shared cloud computer, and local computer control (Claude/Codex via the bundled CUA driver). Native dictation is unavailable.

The NSIS installer registers a **per-user** Windows service named `velarixbot-harness` (`type= userown`, not LocalSystem). It starts the packaged Electron binary with `--harness-service` so the harness can unseal `safeStorage` secrets in your user session.

## Local harness service

Routines and nudges tick while the **local harness service** is running — not only while the window is open, and not via a cloud scheduler. Sleep, lid-close, and power-off still miss their ticks; each routine's missed-run policy applies. The first packaged launch enables the service (macOS writes `~/Library/LaunchAgents/com.velarix.bot.harness.plist` with `LimitLoadToSessionType=Aqua`). OS login starts the service without opening the GUI; OS logout stops it.

Start or stop the service **without** launching the GUI:

macOS:

```sh
# start (after the LaunchAgent plist exists)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.velarix.bot.harness.plist
launchctl kickstart "gui/$(id -u)/com.velarix.bot.harness"

# prove it is up (GUI not required). Body is exactly app, pid, static, stamp.
curl -sS http://127.0.0.1:8799/api/health

# stop
launchctl bootout "gui/$(id -u)/com.velarix.bot.harness"
```

Windows (from an unelevated user session — this is a per-user service, not a machine service):

```powershell
sc.exe start velarixbot-harness
# GET http://127.0.0.1:8799/api/health  → app=velarixbot, static=true
sc.exe stop velarixbot-harness
```

`launchctl bootstrap` / `sc.exe start` are idempotent when the service is already running: they must not fork a second harness. Dragging the app to Trash or running the NSIS uninstaller is not enough unless the service is stopped and unregistered (see Uninstall).

## Updates

Updates are manual because the source and releases are private. Download the next release from this repository, verify its checksum, and install it over the existing version. Your bots, transcripts, routines, and settings remain in the VelarixBot user-data directory.

## Uninstall

Removing the app does not delete leftover config or bot data. **Stop and unregister the user-session service** or the harness keeps running after the GUI is gone.

- **macOS:** stop the LaunchAgent, then drag `/Applications/VelarixBot.app` to Trash:

  ```sh
  launchctl bootout "gui/$(id -u)/com.velarix.bot.harness"
  rm -f ~/Library/LaunchAgents/com.velarix.bot.harness.plist
  ```

  After that, `curl http://127.0.0.1:8799/api/health` must fail. Leftover folders: `~/Library/Application Support/VelarixBot` (app prefs) and `~/.velarixbot` (bots, transcripts, keys, per-bot workspaces).

- **Windows:** the NSIS uninstaller runs `sc.exe stop velarixbot-harness` and `sc.exe delete velarixbot-harness`. If you copied the app without the installer, stop and delete that per-user service yourself before removing the files. Leftover folders: `%APPDATA%\VelarixBot` (app prefs) and `%USERPROFILE%\.velarixbot` (bots, transcripts, keys, per-bot workspaces).

Delete those folders only if you want a clean slate.
