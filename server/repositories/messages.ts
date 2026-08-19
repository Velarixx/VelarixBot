// Message rows. An append is one INSERT — it never rewrites earlier
// messages, so transcript growth is O(1) per message (pinned by test:
// append #100,001 leaves the first 100,000 bytes of the main db file
// untouched). Screenshot payloads never enter SQLite: png bytes go to the
// content-hash blob store and the row carries only the hash.
import { deleteBlob, putBlobBase64, readBlob, readBlobBase64 } from "../db/blobs.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { normalizeMessage, type Message } from "../store.ts";
import { newId } from "../contracts.ts";

interface MessageRow {
  id: string;
  thread_id: string;
  at: number;
  png_hash: string | null;
  data: string;
  seq?: number;
}

function rowToMessage(row: MessageRow, slim = false): Message | null {
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
    if (slim) {
      delete message.png;
      message.hasImage = true;
    } else {
      const png = readBlobBase64(row.png_hash);
      if (png) message.png = png;
    }
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

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
}

export interface MessagesRepository {
  /** Legacy desktop access. These methods intentionally include unowned and
   * tenant-owned rows and must never be used as a tenant security boundary. */
  forThread(threadId: string): Message[];
  /** Newest `limit` messages before an optional cursor. `null` means the
   * `before` id is not in this thread — callers must 404, not wrap. */
  pageForThread(threadId: string, opts: { limit: number; before?: string | null; slim?: boolean }): MessagePage | null;
  find(threadId: string, id: string): Message | null;
  /** Raw screenshot bytes for one message, or null when it has none. */
  readImage(threadId: string, id: string): { bytes: Buffer; mime: string } | null;
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

  /** Bind every message operation to one internal user UUID. The returned
   * interface has no unscoped escape hatch and excludes owner_id=NULL rows. */
  forOwner(ownerId: string): TenantMessagesRepository;
}

export interface TenantMessagesRepository {
  forThread(threadId: string): Message[];
  pageForThread(threadId: string, opts: { limit: number; before?: string | null; slim?: boolean }): MessagePage | null;
  find(threadId: string, id: string): Message | null;
  readImage(threadId: string, id: string): { bytes: Buffer; mime: string } | null;
  append(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number; id?: string }): Message;
  patch(threadId: string, id: string, patch: Partial<Message>): Message | null;
  deleteThread(threadId: string): boolean;
  countForThread(threadId: string): number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertOwnerId(ownerId: string): void {
  if (!UUID_PATTERN.test(ownerId)) throw new TypeError("ownerId must be an internal UUID");
}

export function createMessagesRepository(
  db: SqliteDatabase,
  opts?: { extraReferencedBlobs?: () => ReadonlySet<string> },
): MessagesRepository {
  const ensureThread = db.prepare("INSERT OR IGNORE INTO threads(id, bot_id, created_at) VALUES (?, NULL, ?)");
  const insert = db.prepare("INSERT INTO messages(id, thread_id, at, png_hash, data) VALUES (?, ?, ?, ?, ?)");
  const update = db.prepare("UPDATE messages SET at = ?, png_hash = ?, data = ? WHERE thread_id = ? AND id = ?");
  const selectThread = db.prepare<MessageRow>(
    "SELECT id, thread_id, at, png_hash, data FROM messages WHERE thread_id = ? ORDER BY seq",
  );
  const selectOne = db.prepare<MessageRow>(
    "SELECT id, thread_id, at, png_hash, data FROM messages WHERE thread_id = ? AND id = ?",
  );
  const selectSeq = db.prepare<{ seq: number }>("SELECT seq FROM messages WHERE thread_id = ? AND id = ?");
  const selectNewest = db.prepare<MessageRow>(
    "SELECT id, thread_id, at, png_hash, data, seq FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?",
  );
  const selectBefore = db.prepare<MessageRow>(
    "SELECT id, thread_id, at, png_hash, data, seq FROM messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
  );
  const countOlder = db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages WHERE thread_id = ? AND seq < ?");
  const selectThreadHashes = db.prepare<{ png_hash: string }>(
    "SELECT DISTINCT png_hash FROM messages WHERE thread_id = ? AND png_hash IS NOT NULL",
  );
  const countHashRefs = db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages WHERE png_hash = ?");
  const countThread = db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages WHERE thread_id = ?");
  const selectOwnedThread = db.prepare<{ id: string }>("SELECT id FROM threads WHERE owner_id = ? AND id = ?");
  const deleteThreadMessages = db.prepare("DELETE FROM messages WHERE thread_id = ?");
  const deleteThreadEvents = db.prepare("DELETE FROM event_log WHERE thread_id = ?");
  const deleteThreadRow = db.prepare("DELETE FROM threads WHERE id = ?");

  const appendTx = db.transaction((threadId: string, message: Message, pngHash: string | null, data: string) => {
    ensureThread.run(threadId, message.at);
    insert.run(message.id, threadId, message.at, pngHash, data);
  });

  const appendOwnedTx = db.transaction((ownerId: string, threadId: string, message: Message): Message => {
    if (!ownsThread(ownerId, threadId)) throw new Error("tenant thread not found");
    const { data, pngHash } = toRow(message);
    insert.run(message.id, threadId, message.at, pngHash, data);
    return message;
  });

  const deleteRows = (threadId: string): string[] => {
    const hashes = selectThreadHashes.all(threadId).map((r) => r.png_hash);
    deleteThreadMessages.run(threadId);
    deleteThreadEvents.run(threadId);
    deleteThreadRow.run(threadId);
    return hashes;
  };
  const deleteTx = db.transaction(deleteRows);

  function ownsThread(ownerId: string, threadId: string): boolean {
    return selectOwnedThread.get(ownerId, threadId) !== undefined;
  }

  function pageForThread(
    threadId: string,
    opts: { limit: number; before?: string | null; slim?: boolean },
  ): MessagePage | null {
    let beforeSeq: number | undefined;
    if (opts.before) {
      const cursor = selectSeq.get(threadId, opts.before);
      if (!cursor) return null;
      beforeSeq = cursor.seq;
    }
    if (opts.limit === 0) {
      const older = beforeSeq !== undefined
        ? (countOlder.get(threadId, beforeSeq)?.n ?? 0)
        : (countThread.get(threadId)?.n ?? 0);
      return { messages: [], hasMore: older > 0 };
    }
    const rows = beforeSeq !== undefined
      ? selectBefore.all(threadId, beforeSeq, opts.limit)
      : selectNewest.all(threadId, opts.limit);
    rows.reverse();
    const oldestSeq = rows[0]?.seq;
    const hasMore = oldestSeq !== undefined
      ? (countOlder.get(threadId, oldestSeq)?.n ?? 0) > 0
      : false;
    return {
      messages: rows.map((row) => rowToMessage(row, opts.slim === true)).filter((m): m is Message => !!m),
      hasMore,
    };
  }

  function find(threadId: string, id: string): Message | null {
    const row = selectOne.get(threadId, id);
    return row ? rowToMessage(row) : null;
  }

  function readImageForMessage(threadId: string, id: string): { bytes: Buffer; mime: string } | null {
    const row = selectOne.get(threadId, id);
    if (!row?.png_hash) return null;
    const bytes = readBlob(row.png_hash);
    if (!bytes) return null;
    let mime = "image/png";
    try {
      const parsed = JSON.parse(row.data) as { mime?: unknown };
      if (typeof parsed.mime === "string" && parsed.mime) mime = parsed.mime;
    } catch {
      /* default */
    }
    return { bytes, mime };
  }

  function append(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number; id?: string }): Message {
    const full: Message = { id: message.id ?? newId(), at: Date.now(), ...message } as Message;
    const { data, pngHash } = toRow(full);
    appendTx(threadId, full, pngHash, data);
    return full;
  }

  function patchMessage(threadId: string, id: string, patch: Partial<Message>): Message | null {
    const existing = find(threadId, id);
    if (!existing) return null;
    const merged: Message = { ...existing, ...patch, card: patch.card ?? existing.card, id, at: patch.at ?? existing.at };
    const { data, pngHash } = toRow(merged);
    update.run(merged.at, pngHash, data, threadId, id);
    return merged;
  }

  function gcBlobHashes(hashes: string[]): void {
    // after commit only: content-addressed files are harmless while a
    // hash is still referenced by another thread OR a bot avatar
    const extra = opts?.extraReferencedBlobs?.() ?? new Set<string>();
    for (const hash of hashes) {
      if (extra.has(hash)) continue;
      if ((countHashRefs.get(hash)?.n ?? 0) === 0) deleteBlob(hash);
    }
  }

  function forOwner(ownerId: string): TenantMessagesRepository {
    assertOwnerId(ownerId);
    const patchOwnedTx = db.transaction((threadId: string, id: string, messagePatch: Partial<Message>): Message | null => {
      if (!ownsThread(ownerId, threadId)) return null;
      return patchMessage(threadId, id, messagePatch);
    });
    const deleteOwnedTx = db.transaction((threadId: string): string[] | null => {
      if (!ownsThread(ownerId, threadId)) return null;
      return deleteRows(threadId);
    });
    return {
      forThread(threadId) {
        if (!ownsThread(ownerId, threadId)) return [];
        return selectThread.all(threadId).map((row) => rowToMessage(row)).filter((m): m is Message => !!m);
      },
      pageForThread(threadId, pageOpts) {
        if (!ownsThread(ownerId, threadId)) return null;
        return pageForThread(threadId, pageOpts);
      },
      find(threadId, id) {
        if (!ownsThread(ownerId, threadId)) return null;
        return find(threadId, id);
      },
      readImage(threadId, id) {
        if (!ownsThread(ownerId, threadId)) return null;
        return readImageForMessage(threadId, id);
      },
      append(threadId, message) {
        // Authorization and INSERT share one SQLite transaction, and toRow
        // only writes a blob after that authorization succeeds. There is no
        // INSERT OR IGNORE here: tenant append cannot create/claim a thread.
        const full: Message = { id: message.id ?? newId(), at: Date.now(), ...message } as Message;
        return appendOwnedTx(ownerId, threadId, full);
      },
      patch(threadId, id, messagePatch) {
        // Authorize before reading image bytes or writing replacement blobs.
        return patchOwnedTx(threadId, id, messagePatch);
      },
      deleteThread(threadId) {
        const hashes = deleteOwnedTx(threadId);
        if (!hashes) return false;
        gcBlobHashes(hashes);
        return true;
      },
      countForThread(threadId) {
        if (!ownsThread(ownerId, threadId)) return 0;
        return countThread.get(threadId)?.n ?? 0;
      },
    };
  }

  return {
    forThread(threadId) {
      return selectThread.all(threadId).map((row) => rowToMessage(row)).filter((m): m is Message => !!m);
    },
    pageForThread(threadId, opts) {
      return pageForThread(threadId, opts);
    },
    find(threadId, id) {
      return find(threadId, id);
    },
    readImage(threadId, id) {
      return readImageForMessage(threadId, id);
    },
    append(threadId, message) {
      return append(threadId, message);
    },
    patch(threadId, id, patch) {
      return patchMessage(threadId, id, patch);
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
      gcBlobHashes(hashes);
    },
    countForThread(threadId) {
      return countThread.get(threadId)?.n ?? 0;
    },
    blobRefCount(hash) {
      return countHashRefs.get(hash)?.n ?? 0;
    },
    forOwner,
  };
}
