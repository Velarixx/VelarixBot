import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  TOKEN_RE,
  healthWithoutSecrets,
  parseServiceAuth,
  readServiceAuth,
  removeServiceAuth,
  serviceAuthPath,
  writeServiceAuth,
} from "./service-auth.mjs";

function tempHome(tag: string): string {
  const home = join(tmpdir(), `velarix-service-auth-${tag}-${process.pid}-${Date.now()}`);
  mkdirSync(join(home, ".velarixbot"), { recursive: true, mode: 0o700 });
  return home;
}

function canaryToken(): string {
  return `${"ab".repeat(16)}${"cd".repeat(16)}`;
}

describe("service-auth sidecar", () => {
  it("parses only a velarixbot sidecar with a 256-bit hex token", () => {
    const token = canaryToken();
    expect(TOKEN_RE.test(token)).toBe(true);
    expect(parseServiceAuth({ app: "velarixbot", pid: 42, port: 8799, token })).toEqual({
      app: "velarixbot",
      pid: 42,
      port: 8799,
      token,
    });
    expect(parseServiceAuth({ app: "velarixbot", pid: 42, port: 8799, token: "short" })).toBeNull();
    expect(parseServiceAuth({ app: "other", pid: 42, port: 8799, token })).toBeNull();
    expect(parseServiceAuth({ app: "velarixbot", pid: -1, port: 8799, token })).toBeNull();
    expect(parseServiceAuth(null)).toBeNull();
  });

  it("writes and reads under isolated HOME and never puts the token on a health object", () => {
    const home = tempHome("roundtrip");
    const token = canaryToken();
    const written = writeServiceAuth({ pid: 99, port: 8799, token }, home);
    expect(written.token).toBe(token);
    expect(readServiceAuth(home)).toEqual(written);
    expect(serviceAuthPath(home)).toBe(join(home, ".velarixbot", "service-auth.json"));
    const disk = JSON.parse(readFileSync(serviceAuthPath(home), "utf8")) as { token: string };
    expect(disk.token).toBe(token);

    const health = healthWithoutSecrets({
      app: "velarixbot",
      pid: 99,
      static: true,
      stamp: "ensureBotWorkspace+mcpOverlay",
      token,
      fleet: ["secret"],
    });
    expect(health).toEqual({
      app: "velarixbot",
      pid: 99,
      static: true,
      stamp: "ensureBotWorkspace+mcpOverlay",
    });
    expect(JSON.stringify(health)).not.toContain(token);
    expect(Object.keys(health ?? {}).sort()).toEqual(["app", "pid", "stamp", "static"]);

    removeServiceAuth(home);
    expect(readServiceAuth(home)).toBeNull();
    expect(existsSync(serviceAuthPath(home))).toBe(false);
  });

  const posixOnly = process.platform === "win32" ? it.skip : it;
  posixOnly("keeps sidecar dir 0700 and service-auth.json 0600 — POSIX-only: Windows has no Unix mode bits", () => {
    const home = tempHome("mode");
    writeServiceAuth({ pid: 1, port: 8799, token: canaryToken() }, home);
    expect(statSync(join(home, ".velarixbot")).mode & 0o777).toBe(0o700);
    expect(statSync(serviceAuthPath(home)).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt sidecar as missing (do not adopt)", () => {
    const home = tempHome("corrupt");
    writeFileSync(serviceAuthPath(home), "{not-json", { mode: 0o600 });
    expect(readServiceAuth(home)).toBeNull();
    mkdirSync(join(home, ".velarixbot"), { recursive: true });
    writeFileSync(serviceAuthPath(home), JSON.stringify({ app: "velarixbot", pid: 1, port: 8799 }), {
      mode: 0o600,
    });
    expect(readServiceAuth(home)).toBeNull();
  });
});
