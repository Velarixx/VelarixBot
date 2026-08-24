import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { expectedHashForAsset, hashesEqual, parseSha256Sums, sha256File, verifyDownload } from "./update-verify.mjs";

describe("SHA256SUMS verification", () => {
  it("parses GNU sha256sum lines and matches the installer name", () => {
    const sums = parseSha256Sums(
      [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  VelarixBot-0.3.1-arm64.dmg",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *VelarixBot-Setup-0.3.1-x64.exe",
        "not-a-hash  skip-me.bin",
      ].join("\n"),
    );
    expect(expectedHashForAsset(sums, "VelarixBot-0.3.1-arm64.dmg")).toBe("a".repeat(64));
    expect(expectedHashForAsset(sums, join("release", "VelarixBot-Setup-0.3.1-x64.exe"))).toBe("b".repeat(64));
    expect(expectedHashForAsset(sums, "missing.bin")).toBe("");
  });

  it("compares digests without leaking length-mismatch as equal", () => {
    expect(hashesEqual("ab", "ab")).toBe(true);
    expect(hashesEqual("AB", "ab")).toBe(true);
    expect(hashesEqual("ab", "ac")).toBe(false);
    expect(hashesEqual("ab", "abc")).toBe(false);
    expect(hashesEqual("", "aa")).toBe(false);
  });

  it("verifies a real file and fails closed on mismatch or a missing entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "velarix-sums-"));
    const file = join(dir, "VelarixBot-0.3.1-arm64.dmg");
    writeFileSync(file, "dmg-bytes");
    const digest = createHash("sha256").update("dmg-bytes").digest("hex");

    const ok = await verifyDownload({
      filePath: file,
      assetName: "VelarixBot-0.3.1-arm64.dmg",
      sumsText: `${digest}  VelarixBot-0.3.1-arm64.dmg\n`,
    });
    expect(ok).toEqual({ ok: true, sha256: digest });
    expect(await sha256File(file)).toBe(digest);

    const mismatch = await verifyDownload({
      filePath: file,
      assetName: "VelarixBot-0.3.1-arm64.dmg",
      sumsText: `${"c".repeat(64)}  VelarixBot-0.3.1-arm64.dmg\n`,
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toMatch(/did not match SHA256SUMS/i);

    const missing = await verifyDownload({
      filePath: file,
      assetName: "VelarixBot-0.3.1-arm64.dmg",
      sumsText: `${digest}  other.dmg\n`,
    });
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/no entry/i);
  });
});
