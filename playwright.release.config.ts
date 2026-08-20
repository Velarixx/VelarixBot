import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "fake-engine-smoke.spec.ts",
    "reduced-motion.spec.ts",
    "saas-creation.spec.ts",
    "saas-desktop-access.spec.ts",
    "saas-sign-out.spec.ts",
    "session-boundary.spec.ts",
    "saas-error-recovery.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  reporter: "line",
});
