import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { attachListenError } from "./listen-error.ts";

describe("listen error handler", () => {
  it("exits non-zero on a fake EADDRINUSE — no real port fight", () => {
    const server = new EventEmitter();
    const logs: string[] = [];
    let exitCode: number | undefined;
    attachListenError(server, {
      log: (msg) => logs.push(msg),
      exit: (code) => {
        exitCode = code;
      },
    });
    server.emit("error", Object.assign(new Error("listen EADDRINUSE: address already in use"), { code: "EADDRINUSE" }));
    expect(exitCode).toBe(1);
    expect(exitCode).not.toBe(0);
    expect(logs.join("\n")).toMatch(/EADDRINUSE/);
  });
});
