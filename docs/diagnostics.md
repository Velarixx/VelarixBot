# Diagnostics export + verified backup / restore

Two support surfaces, both local-only and behind the per-launch API token
(like every `/api` route except `/api/health`):

- **Export diagnostics** — one bundle with versions, capabilities, redacted
  logs, and a database integrity result. **Transcripts are never included**:
  the export has no option to include message content, event payloads, or
  screenshots, and API keys are never read at all.
- **Verified backup** — a directory archive of the SQLite profile **and**
  the file-authoritative domains (approval rules, skills, memory markdown)
  plus `config.json` / `secrets.json`. Proven good before it is reported.
  Restore into an empty profile is gated in CI (`server/db/backup.test.ts`),
  not hoped for. A db-only snapshot is not a complete backup: boot
  `refreshSnapshots()` rewrites the SQLite snapshot tables from disk, so
  restoring only `velarixbot.db` onto a fresh machine silently drops rules,
  skills, and memory.

## One-click (Settings)

App Settings → **Diagnostics & backup**:

- **Export diagnostics** downloads `velarixbot-diagnostics-<date>.json`.
- **Back up now** writes a verified archive into the local data directory
  (`~/.velarixbot/backup/velarixbot-<timestamp>/` with `manifest.json`,
  `velarixbot.db`, and the covered files) and shows the path. The UI says
  **Verified** only when every covered domain is included.

Covered: SQLite database (bots, transcripts, routines, event log), approval
rules, skills, memory notes, `config.json`, and `secrets.json`. Manifest
metadata records paths, sizes, and SHA-256 only — never file contents or
secret values. Secret-bearing archive files are `0600`.

## HTTP surface

```
GET  /api/diagnostics/export   → the diagnostics bundle (JSON)
POST /api/diagnostics/backup   → { path, manifest, complete } of a fresh verified archive
```

Both require `Authorization: Bearer <token>`. In dev, set
`VELARIX_DEV_TOKEN` when starting the server and use it:

```
VELARIX_DEV_TOKEN=devtoken node server/index.ts
curl -H "Authorization: Bearer devtoken" http://127.0.0.1:8799/api/diagnostics/export > diagnostics.json
curl -X POST -H "Authorization: Bearer devtoken" http://127.0.0.1:8799/api/diagnostics/backup
```

## What the export contains (and what it never contains)

| Section | Contents |
| --- | --- |
| `versions` | app version, node version, platform/arch, DB schema version, build stamp |
| `capabilities` | provider fleet (instance id, driver kind, availability state/reason, CLI version, model catalog) and computer providers (id, kind, capability flags) |
| `integrity` | `PRAGMA integrity_check` result on the live database + per-table row **counts** (counts only, never content) |
| `logs` | the newest event-log entries as **metadata only** (type, ids, timestamps — the payload column is never selected: `recentMeta` in `server/repositories/event-log.ts`) and the approval audit trail (matchers are redacted at write time) |

Never included: message/transcript content, event payloads, screenshots or
blobs, `config.json`, or API keys. `transcriptsIncluded` is hardwired
`false`. As defense in depth, every string in the bundle passes through
`redactSecrets` (`server/approvals.ts`) before it is returned
(`redactDeep` in `server/services/diagnostics.ts`). These guarantees are
pinned by `server/services/diagnostics.test.ts` and the end-to-end cases in
`server/index.test.ts`.

## How a backup is "verified"

`createVerifiedBackup` (`server/db/backup.ts`):

1. `VACUUM INTO` writes a compact, transaction-consistent snapshot of the
   live database — WAL content included, no checkpoint or downtime needed.
2. The snapshot is reopened and must pass `PRAGMA integrity_check`.
3. Every domain table's row count in the snapshot must equal the source.
4. Approval rules, skills, memory markdown, `config.json`, and `secrets.json`
   that exist on disk are copied into the archive directory (0600 for
   secret-bearing files). Empty domains are still recorded as included.
5. `manifest.json` records the SHA-256 of the database bytes, the size, the
   schema version, the per-table counts, and per-file checksums (paths +
   hashes only). `complete` is true only when every covered domain is
   included.

Any verification failure removes the archive and throws — an unverified
archive is never left behind. A green check / `complete: true` is not
returned if a covered domain is missing.

## Restore into an empty profile

Restore targets a profile with **no existing database** and no existing
covered files (a fresh machine or a data dir whose `velarixbot.db` and
those files were moved aside). It re-verifies the archive (manifest
SHA-256 + `integrity_check` + per-file checksums) *before* copying, and
re-counts every table after opening the restored copy; any failure removes
the partial target. Restored files are what `refreshSnapshots()` reads on
the next boot.

With the app quit, from a source checkout:

```
node scripts/restore-profile.mjs ~/.velarixbot/backup/velarixbot-<timestamp>
```

A v1 `<backup.db>` + sidecar manifest still restores the database only and
is reported as incomplete. An explicit target path can be passed as the
second argument. The restored database opens under the current build's
migrations, so a backup restores cleanly into the same or a newer app
version.

CI proof: `server/db/backup.test.ts` (runs in the `pnpm test` step of
`ci.yml`) populates a profile (db + approvals + skill + memory), backs it
up, wipes the profile except the archive, restores, and checks the three
file-authoritative domains survive `refreshSnapshots()` — plus tamper/
checksum, missing-manifest, occupied-target, WAL-content, and
incomplete-archive (no green check) cases.
