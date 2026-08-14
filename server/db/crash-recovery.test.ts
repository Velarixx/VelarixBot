// Crash-recovery harness (P0.4 acceptance): SIGKILL the writer mid-append
// and prove that every acknowledged (committed) message survives — the kill
// loses at most the one in-flight message — and that the database file is
// not corrupted. Windows-safe: argv-only spawn, no shell, no sleeps (waits
// ride on stdout lines and the exit event).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { openDatabase } from "./database.ts";
import { createMessagesRepository } from "../repositories/messages.ts";

const CRASH_WRITER = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "crash-writer.ts");

describe("crash-recovery harness", () => {
  it("a SIGKILL mid-append loses at most the in-flight message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-crash-"));
    const dbPath = join(dir, "crash.db");
    const child = spawn(process.execPath, [CRASH_WRITER, dbPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr += c));

    // fold stdout into acknowledged-append counts; kill after enough commits
    const TARGET = 50;
    let acknowledged = 0;
    let buffered = "";
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on("data", (chunk) => {
        buffered += chunk;
        let idx;
        while ((idx = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, idx).trim();
          buffered = buffered.slice(idx + 1);
          const match = /^APPENDED (\d+)$/.exec(line);
          if (match) acknowledged = Number(match[1]);
        }
        if (acknowledged >= TARGET) {
          child.kill("SIGKILL");
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (acknowledged < TARGET) reject(new Error(`writer exited early (${code ?? signal}). stderr:\n${stderr}`));
      });
    });
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.on("exit", () => resolve());
    });

    // reopen: WAL recovery must yield every acknowledged commit, intact
    const db = openDatabase(dbPath);
    try {
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      const messages = createMessagesRepository(db);
      const survived = messages.countForThread("crash-thread");
      // every acknowledged (committed) append survived the kill
      expect(survived).toBeGreaterThanOrEqual(acknowledged);
      // and what survived is a CONTIGUOUS prefix 1..survived — the only
      // thing the kill may take is the trailing in-flight append, never a
      // committed message from the middle
      const list = messages.forThread("crash-thread");
      expect(list).toHaveLength(survived);
      list.forEach((message, i) => {
        expect(message.text).toBe(`message ${i + 1}`);
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
