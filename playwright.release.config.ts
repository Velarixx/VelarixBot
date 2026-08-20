import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "fake-engine-smoke.spec.ts",
    "session-boundary.spec.ts",
    "saas-error-recovery.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  reporter: "line",
});
