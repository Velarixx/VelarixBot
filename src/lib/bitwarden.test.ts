import { describe, expect, it } from "vitest";

import { BITWARDEN_PATHS, bitwardenIds, toggleBitwardenId } from "./bitwarden";

describe("bitwardenIds", () => {
  it("treats empty or missing as none", () => {
    expect(bitwardenIds(undefined)).toEqual([]);
    expect(bitwardenIds([])).toEqual([]);
    expect(bitwardenIds(["", "  "])).toEqual([]);
  });

  it("dedupes and trims", () => {
    expect(bitwardenIds([" a ", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("toggleBitwardenId", () => {
  it("adds and removes without inventing an enable-all", () => {
    expect(toggleBitwardenId([], "sec-1")).toEqual(["sec-1"]);
    expect(toggleBitwardenId(["sec-1"], "sec-2")).toEqual(["sec-1", "sec-2"]);
    expect(toggleBitwardenId(["sec-1", "sec-2"], "sec-1")).toEqual(["sec-2"]);
    expect(toggleBitwardenId([], "")).toEqual([]);
  });
});

describe("bitwarden paths", () => {
  it("keeps status and disconnect on the integrations surface", () => {
    expect(BITWARDEN_PATHS.status).toBe("/api/bitwarden");
    expect(BITWARDEN_PATHS.disconnect).toBe("/api/bitwarden/disconnect");
  });
});
