import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { safeOpenAttachment } from "./safe-open.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "safe-open.ts");

describe("attachment safe-open", () => {
  it("allows read/reveal and refuses executables and secret config", () => {
    expect(safeOpenAttachment({ path: join(DATA_DIR, "shot.png"), mime: "image/png" })).toEqual({
      allowed: true,
      mode: "read",
    });
    expect(safeOpenAttachment({ path: join(DATA_DIR, "notes.md") })).toEqual({ allowed: true, mode: "read" });
    expect(safeOpenAttachment({ path: join(DATA_DIR, "archive.zip") })).toEqual({ allowed: true, mode: "reveal" });
    expect(safeOpenAttachment({ path: join(DATA_DIR, "tool.exe") })).toEqual({
      allowed: false,
      reason: "executable attachments cannot be opened",
    });
    expect(safeOpenAttachment({ path: join(DATA_DIR, "config.json") })).toEqual({
      allowed: false,
      reason: "secret configuration files cannot be opened",
    });
  });

  it("does not execute the file and never imports a shell or child_process", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).not.toMatch(/from ["']node:child_process["']/);
    expect(src).not.toMatch(/shell\s*:\s*true/);
    expect(src).not.toMatch(/\bexecFile\b|\bspawnSync\b|\bexecSync\b/);
    const decision = safeOpenAttachment({ path: join(DATA_DIR, "payload.bat") });
    expect(decision.allowed).toBe(false);
  });
});
