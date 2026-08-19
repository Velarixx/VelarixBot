import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ApplicationRoot,
  DesktopApplication,
  InvalidApplicationMode,
} from "@/App";
import { SessionBoundary } from "./SessionBoundary";
import { resolveClientApplicationMode, trustedClientApplicationMode } from "./mode";

const HERE = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(HERE, "..", "App.tsx"), "utf8");
const modeSource = readFileSync(join(HERE, "mode.ts"), "utf8");

describe("trusted client application mode", () => {
  it("preserves desktop when configuration is missing and accepts only exact reviewed values", () => {
    expect(resolveClientApplicationMode(undefined)).toBe("desktop");
    expect(resolveClientApplicationMode(null)).toBe("desktop");
    expect(resolveClientApplicationMode("")).toBe("desktop");
    expect(resolveClientApplicationMode("desktop")).toBe("desktop");
    expect(resolveClientApplicationMode("saas")).toBe("saas");
    for (const invalid of ["SaaS", " saas ", "browser", false, 1]) {
      expect(resolveClientApplicationMode(invalid)).toBe("invalid");
    }
  });

  it("keeps the trusted adapter injectable without hiding Vite's static environment access", () => {
    expect(trustedClientApplicationMode(undefined)).toBe("desktop");
    expect(trustedClientApplicationMode("saas")).toBe("saas");
    expect(trustedClientApplicationMode("invalid-value")).toBe("invalid");
    expect(modeSource).toContain("import.meta.env.VITE_VELARIX_APP_MODE");
  });

  it("selects composition before either boundary mounts", () => {
    expect(ApplicationRoot({ mode: "desktop" }).type).toBe(DesktopApplication);
    expect(ApplicationRoot({ mode: "saas" }).type).toBe(SessionBoundary);
    expect(ApplicationRoot({ mode: "invalid" }).type).toBe(InvalidApplicationMode);
  });

  it("uses build/runtime configuration only, never browser heuristics", () => {
    expect(modeSource).toContain("VITE_VELARIX_APP_MODE");
    expect(modeSource).not.toMatch(/URLSearchParams|searchParams|localStorage|electron|window\.|location\./i);
    expect(appSource).toContain("<StoreProvider>");
    expect(appSource).toContain("<SessionBoundary />");
    expect(appSource).toContain("Connecting to the bot server");
    expect(appSource).not.toContain("401");
  });
});
