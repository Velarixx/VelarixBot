# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Email **soni.mil2001@gmail.com** with
the details (or use GitHub's private vulnerability reporting on this repo if enabled). You'll get a
response as soon as possible, normally within a few days.

## Scope notes for researchers

- The harness server binds **127.0.0.1 only** and has no authentication by design — it trusts the
  local user. Anything that makes it reachable from off-machine, or lets one local *unprivileged
  other user* drive it, is a vulnerability.
- API keys are write-only through the API (`configured` booleans out, never values) and are sealed
  into `~/.velarixbot/secrets.json` — OS keychain via Electron `safeStorage` in the desktop app, a
  0600 base64 fallback when headless; `~/.velarixbot/config.json` holds only `secret://` references.
  Any path that echoes a stored secret back — API response, SSE event, log line, argv visible in
  `ps` — is a vulnerability, as is anything that writes a plaintext secret into `config.json`.
- Agents run real CLIs (`claude`, `codex`) with the user's own privileges, and the permission broker
  is the consent layer for risky actions. Bypasses of the broker (approving without a user decision,
  spoofing the broker socket) are vulnerabilities.
- Spawning must never route user-influenced strings through a shell. Report any `shell: true` /
  `cmd.exe` string-building you find.
