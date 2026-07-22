import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: path.join(os.tmpdir(), "agentic-workbench-playwright-results"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["line"]],
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off"
  }
});
