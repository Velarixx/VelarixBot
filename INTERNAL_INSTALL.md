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

Do not disable SmartScreen or Microsoft Defender globally. The first Windows release supports bots and the shared cloud computer; local Windows computer control and native dictation are unavailable.

## Updates

Updates are manual because the source and releases are private. Download the next release from this repository, verify its checksum, and install it over the existing version. Your bots, transcripts, routines, and settings remain in the VelarixBot user-data directory.
