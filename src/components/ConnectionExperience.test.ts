import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(HERE, "..", "App.tsx"), "utf8");
const composer = readFileSync(join(HERE, "Composer.tsx"), "utf8");

describe("connection-loss experience", () => {
  it("announces reconnecting state without exposing transport internals", () => {
    expect(app).toContain('role="status"');
    expect(app).toContain('aria-live="polite"');
    expect(app).toContain("Connection lost. Reconnecting");
    expect(app).toContain("drafts stay here until you can send");
    expect(app).not.toMatch(/EventSource|SSE/);
  });

  it("keeps a draft intact while disconnected", () => {
    const guard = composer.indexOf("if (!state.connected) return;");
    const clear = composer.indexOf('setText("");', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(guard);
    expect(composer).toContain("reconnecting to send");
  });
});
