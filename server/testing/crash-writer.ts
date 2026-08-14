// Crash-harness child: opens the database at argv[2] and appends messages
// forever, printing "APPENDED <n>" to stdout AFTER each commit returns.
// The parent test counts acknowledged appends, SIGKILLs this process mid-
// loop, reopens the database, and asserts that every acknowledged append
// survived — a kill loses at most the one in-flight message. Dev-only
// (server/testing is excluded from the packaged build).
import { openDatabase } from "../db/database.ts";
import { createMessagesRepository } from "../repositories/messages.ts";

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write("usage: crash-writer.ts <db-path>\n");
  process.exit(2);
}

const db = openDatabase(dbPath);
const messages = createMessagesRepository(db);
const threadId = "crash-thread";

let n = 0;
function appendForever(): void {
  for (;;) {
    n++;
    messages.append(threadId, { role: "user", kind: "text", text: `message ${n}` });
    // the commit has returned — this append must survive a kill
    process.stdout.write(`APPENDED ${n}\n`);
  }
}

process.stdout.write("READY\n");
appendForever();
