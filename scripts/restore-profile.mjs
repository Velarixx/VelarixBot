// Restore-into-empty-profile, as a runnable support tool (the same
// code path server/db/backup.test.ts gates in CI). Run from a source
// checkout with dependencies installed (node >= 24):
//
//   node scripts/restore-profile.mjs <backup-dir-or-v1.db> [target-db-path]
//
// v2 archives are a directory (manifest.json + velarixbot.db + covered
// files). A v1 `<backup.db>` + `<backup.db>.manifest.json` still restores
// the database only and is reported as incomplete — approvals, skills,
// and memory markdown are not in that format. The target defaults to the
// real profile database (~/.velarixbot/velarixbot.db) and MUST NOT exist
// yet — move an existing database (and covered files) aside first. The
// archive is verified (sha256 against the manifest + PRAGMA integrity_check
// + per-file checksums) before anything is copied, and the restored copy
// is re-verified after.
import { restoreBackupIntoEmptyProfile } from "../server/db/backup.ts";
import { defaultDbPath } from "../server/db/database.ts";

const [backupPath, targetArg] = process.argv.slice(2);
if (!backupPath) {
  process.stderr.write("usage: node scripts/restore-profile.mjs <backup-dir-or-v1.db> [target-db-path]\n");
  process.exit(2);
}

const target = targetArg || defaultDbPath();
try {
  const outcome = restoreBackupIntoEmptyProfile(backupPath, target);
  process.stdout.write(`restored ${backupPath} → ${target}\n`);
  process.stdout.write(`verified sha256 ${outcome.sha256}\n`);
  process.stdout.write(`schema version ${outcome.schemaVersion}; rows: ${JSON.stringify(outcome.tables)}\n`);
  if (outcome.complete) {
    process.stdout.write("complete: yes (database, approvals, skills, memory, config.json, secrets.json)\n");
  } else {
    process.stderr.write(
      "complete: no — this archive does not cover approvals, skills, memory, config.json, and secrets.json. It is not a verified full-profile restore.\n",
    );
  }
} catch (e) {
  process.stderr.write(`restore failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
