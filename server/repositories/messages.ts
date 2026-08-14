// Message rows. An append is one INSERT — it never rewrites earlier
// messages, so transcript growth is O(1) per message (pinned by test:
// append #100,001 leaves the first 100,000 bytes of the main db file
// untouched). Screenshot payloads never enter SQLite: png bytes go to the
// content-hash blob store and the row carries only the hash.
import { deleteBlob, putBlobBase64, readBlobBase64 } from "../db/blobs.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { normalizeMessage, type Message } from "../store.ts";
import { newId } from "../contracts.ts";

interface MessageRow {
  id: string;
  thread_id: string;
  at: number;
  png_hash: string | null;
  data: string;
}

function rowToMessage(row: MessageRow): Message | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return null;
  }
  const message = normalizeMessage(parsed);
  if (!message) return null;
  message.id = row.id;
  message.at = row.at;
  if (row.png_hash) {
    const png = readBlobBase64(row.png_hash);
    if (png) message.png = png;
  }
  return message;
}

/** Split a message into its row JSON (png externalized) + blob hash. */
function toRow(message: Message): { data: string; pngHash: string | null } {
  if (typeof message.png === "string" && message.png) {
    const { png, ...rest } = message;
    return { data: JSON.stringify(rest), pngHash: putBlobBase64(png) };
  }
  return { data: JSON.stringify(message), pngHash: null };
}

export interface MessagesRepository {
  forThread(threadId: string): Message[];
  find(threadId: string, id: string): Message | null;
  append(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number; id?: string }): Message;
  patch(threadId: string, id: string, patch: Partial<Message>): Message | null;
  /** All-or-nothing: the thread row, its messages, and its event-log rows
   * go in ONE transaction; a failure anywhere leaves everything intact. */
  deleteThread(threadId: string): boolean;
  /** Row deletion only — joins the caller's transaction (savepoint) and
   * returns the blob hashes the thread referenced. Callers MUST run
   * gcBlobHashes AFTER their transaction commits: file deletion is not
   * transactional and must never precede the commit it depends on. */
  deleteThreadRows(threadId: string): string[];
  gcBlobHashes(hashes: string[]): void;
  countForThread(threadId: string): number;
  blobRefCount(hash: string): number;
}

export function createMessagesRepository(db: SqliteDatabase): MessagesRepository {
  const ensureThread = db.prepare("INSERT OR IGNORE INTO threads(id, bot_id, created_at) VALUES (?, NULL, ?)");
  const insert = db.prepare("INSERT INTO messages(id, thread_id, at, png_hash, data) VALUES (?, ?, ?, ?, ?)");
  const update = db.prepare("UPDATE messages SET at = ?, png_hash = ?, data = ? WHERE thread_id = ? AND id = ?");
  const selectThread = db.prepare<MessageRow>(
    "SELECT id, thread_id, at, png_hash, data FROM messages WHERE thread_id = ? ORDER BY seq",
  );
  const selectOne = db.prepare<MessageRow>(
    "SELECT id, thread_id, at, png_hash, data FROM messages WHERE thread_id = ? AND id = ?",
  );
  const selectThreadHashes = db.prepare<{ png_hash: string }>(
    "SELECT DISTINCT png_hash FROM messages WHERE thread_id = ? AND png_hash IS NOT NULL",
  );
  const countHashRefs = db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages WHERE png_hash = ?");
  const countThread = db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages WHERE thread_id = ?");
  const deleteThreadMessages = db.prepare("DELETE FROM messages WHERE thread_id = ?");
  const deleteThreadEvents = db.prepare("DELETE FROM event_log WHERE thread_id = ?");
  const deleteThreadRow = db.prepare("DELETE FROM threads WHERE id = ?");

  const appendTx = db.transaction((threadId: string, message: Message, pngHash: string | null, data: string) => {
    ensureThread.run(threadId, message.at);
    insert.run(message.id, threadId, message.at, pngHash, data);
  });

  const deleteRows = (threadId: string): string[] => {
    const hashes = selectThreadHashes.all(threadId).map((r) => r.png_hash);
    deleteThreadMessages.run(threadId);
    deleteThreadEvents.run(threadId);
    deleteThreadRow.run(threadId);
    return hashes;
  };
  const deleteTx = db.transaction(deleteRows);

  return {
    forThread(threadId) {
      return selectThread.all(threadId).map(rowToMessage).filter((m): m is Message => !!m);
    },
    find(threadId, id) {
      const row = selectOne.get(threadId, id);
      return row ? rowToMessage(row) : null;
    },
    append(threadId, message) {
      const full: Message = { id: message.id ?? newId(), at: Date.now(), ...message } as Message;
      const { data, pngHash } = toRow(full);
      appendTx(threadId, full, pngHash, data);
      return full;
    },
    patch(threadId, id, patch) {
      const existing = this.find(threadId, id);
      if (!existing) return null;
      const merged: Message = { ...existing, ...patch, card: patch.card ?? existing.card, id, at: patch.at ?? existing.at };
      const { data, pngHash } = toRow(merged);
      update.run(merged.at, pngHash, data, threadId, id);
      return merged;
    },
    deleteThread(threadId) {
      const hashes = deleteTx(threadId);
      this.gcBlobHashes(hashes);
      return true;
    },
    deleteThreadRows(threadId) {
      return deleteRows(threadId);
    },
    gcBlobHashes(hashes) {
      // after commit only: content-addressed files are harmless while a
      // hash is still referenced by another thread
      for (const hash of hashes) {
        if ((countHashRefs.get(hash)?.n ?? 0) === 0) deleteBlob(hash);
      }
    },
    countForThread(threadId) {
      return countThread.get(threadId)?.n ?? 0;
    },
    blobRefCount(hash) {
      return countHashRefs.get(hash)?.n ?? 0;
    },
  };
}
