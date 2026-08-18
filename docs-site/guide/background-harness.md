# Background harness

Since v0.2 the harness can run as an OS-managed background service, so routines and long turns continue with the app closed.

On macOS, a per-user LaunchAgent runs the harness in your login session — deliberately *not* a daemon, so it keeps access to the Keychain where engine keys and tokens are sealed. On Windows, the installer registers the per-user service `velarixbot-harness` (never LocalSystem) started with `--harness-service`, which lets it unseal `safeStorage` secrets in your user session.

When the app launches it **attaches** to the running harness instead of starting a second one: the health endpoint's pid/stamp contract proves the server is ours and current, and a sidecar bearer token (loopback-only) authenticates the attach. One harness owns the store at a time; a stale or foreign process on the port is detected, never silently adopted.

Everything the background harness does is the same code path as foreground: same permission broker (unattended mode parks approvals in **Needs input**), same SSE stream the app resumes on attach, same local-only binding to `127.0.0.1:8799`.
