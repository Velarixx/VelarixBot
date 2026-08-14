# Diagnostics export + verified backup / restore (P1.7)

Two support surfaces, both local-only and behind the per-launch API token
(like every `/api` route except `/api/health`):

- **Export diagnostics** — one bundle with versions, capabilities, redacted
  logs, and a database integrity result. **Transcripts are never included**:
  the export has no option to include message content, event payloads, or
  screenshots, and API keys are never read at all.
- **Verified backup** — a snapshot of the SQLite profile that is *proven*
  good before it is reported, plus a restore path into an empty profile that
  is gated in CI (`server/db/backup.test.ts`), not hoped for.

## One-click (Settings)

App Settings → **Diagnostics & backup**:

- **Export diagnostics** downloads `velarixbot-diagnostics-<date>.json`.
- **Back up now** writes a verified snapshot into the local data directory
  (`~/.velarixbot/backup/velarixbot-<timestamp>.db` plus its
  `.manifest.json`) and shows the path.

## HTTP surface

```
GET  /api/diagnostics/export   → the diagnostics bundle (JSON)
POST /api/diagnostics/backup   → { path, manifest } of a fresh verified snapshot
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
4. A sidecar `<backup>.manifest.json` records the SHA-256 of the exact bytes,
   the size, the schema version, and the per-table counts.

Any verification failure removes the snapshot and throws — an unverified
archive is never left behind.

## Restore into an empty profile

Restore targets a profile with **no existing database** (a fresh machine or
a data dir whose `velarixbot.db` was moved aside). It re-verifies the
archive (manifest SHA-256 + `integrity_check`) *before* copying, and
re-counts every table after opening the restored copy; any failure removes
the partial target.

With the app quit, from a source checkout:

```
node scripts/restore-profile.mjs ~/.velarixbot/backup/velarixbot-<timestamp>.db
```

An explicit target path can be passed as the second argument. The restored
database opens under the current build's migrations, so a backup restores
cleanly into the same or a newer app version.

CI proof: `server/db/backup.test.ts` (runs in the `pnpm test` step of
`ci.yml`) populates a profile, backs it up, restores into a second empty
profile directory, and compares every table — plus tamper/checksum,
missing-manifest, occupied-target, and WAL-content cases.
