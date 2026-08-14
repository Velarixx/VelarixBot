// P1.7 restore-into-empty-profile, as a runnable support tool (the same
// code path server/db/backup.test.ts gates in CI). Run from a source
// checkout with dependencies installed (node >= 24):
//
//   node scripts/restore-profile.mjs <backup.db> [target-db-path]
//
// The backup's <backup.db>.manifest.json must sit next to it. The target
// defaults to the real profile database (~/.velarixbot/velarixbot.db) and
// MUST NOT exist yet — move an existing database aside first. The archive
// is verified (sha256 against the manifest + PRAGMA integrity_check) before
// anything is copied, and the restored copy is re-verified after.
import { restoreBackupIntoEmptyProfile } from "../server/db/backup.ts";
import { defaultDbPath } from "../server/db/database.ts";

const [backupPath, targetArg] = process.argv.slice(2);
if (!backupPath) {
  process.stderr.write("usage: node scripts/restore-profile.mjs <backup.db> [target-db-path]\n");
  process.exit(2);
}

const target = targetArg || defaultDbPath();
try {
  const outcome = restoreBackupIntoEmptyProfile(backupPath, target);
  process.stdout.write(`restored ${backupPath} → ${target}\n`);
  process.stdout.write(`verified sha256 ${outcome.sha256}\n`);
  process.stdout.write(`schema version ${outcome.schemaVersion}; rows: ${JSON.stringify(outcome.tables)}\n`);
} catch (e) {
  process.stderr.write(`restore failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
