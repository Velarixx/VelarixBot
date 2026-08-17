// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials
// and never spawn a live `claude` binary.
import { describe, expect, it } from "vitest";

import { claudeSignedIn } from "./claude.ts";

type AuthRunner = typeof import("./cli.ts").cliExec;

describe("claudeSignedIn", () => {
  it("uses the CLI's machine-readable auth status", async () => {
    const run = (async (cli, args, opts) => {
      expect(cli).toBe("claude-custom");
      expect(args).toEqual(["auth", "status", "--json"]);
      expect(opts).toMatchObject({ timeout: 8000, env: { PATH: "/custom/bin" } });
      return { ok: true, stdout: '{"loggedIn":true}', stderr: "" };
    }) satisfies AuthRunner;

    expect(await claudeSignedIn("claude-custom", { PATH: "/custom/bin" }, run)).toBe(true);
  });

  it("uses loggedIn:false even though the real CLI exits with code 1", async () => {
    const run = (async () => ({
      ok: false,
      stdout: '{"loggedIn":false,"authMethod":"none"}',
      stderr: "",
    })) satisfies AuthRunner;

    expect(await claudeSignedIn("claude", {}, run)).toBe(false);
  });

  it("fails closed when the command has no valid status", async () => {
    const failed = (async () => ({
      ok: false,
      stdout: "",
      stderr: "auth status unavailable",
    })) satisfies AuthRunner;
    const malformed = (async () => ({
      ok: true,
      stdout: "not json",
      stderr: "",
    })) satisfies AuthRunner;

    expect(await claudeSignedIn("claude", {}, failed)).toBe(false);
    expect(await claudeSignedIn("claude", {}, malformed)).toBe(false);
  });
});
