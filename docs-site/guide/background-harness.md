# Background harness

Since v0.2 the harness can run as an OS-managed background service, so routines and long turns continue with the app closed.

On macOS, a per-user LaunchAgent runs the harness in your login session — deliberately *not* a daemon, so it keeps access to the Keychain where engine keys and tokens are sealed. On Windows, the installer registers the per-user service `velarixbot-harness` (never LocalSystem) started with `--harness-service`, which lets it unseal `safeStorage` secrets in your user session.

When the app launches it **attaches** to the running harness instead of starting a second one: the health endpoint's pid/stamp contract proves the server is ours and current, and a sidecar bearer token (loopback-only) authenticates the attach. One harness owns the store at a time; a stale or foreign process on the port is detected, never silently adopted.

Closing the window — or tray **Quit** — leaves the harness running on purpose. The tray says the background service is still running. **Quit All / Stop Background Service** is the explicit stop: it unloads `gui/<uid>/com.velarix.bot.harness` and writes a non-secret suppress flag under `~/.velarixbot` so a Force Quit or leftover respawn exits without serving. Opening the app or starting the background service again clears that flag. Login `RunAtLoad` does not.

macOS updates use the same stop before replacing `/Applications/VelarixBot.app`. If the LaunchAgent cannot unload or any process is still executing from the installed bundle (including helper/proxy workers whose parent is outside the app), replacement does not start and the error names the leftover pid and path.

Everything the background harness does is the same code path as foreground: same permission broker (unattended mode parks approvals in **Needs input**), same SSE stream the app resumes on attach, same local-only binding to `127.0.0.1:8799`.
