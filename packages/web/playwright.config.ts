import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8801",
    headless: true,
    trace: "on-first-retry",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "node ../engine/dist/cli.js",
    cwd: here,
    env: {
      MINIONS_TOKEN: "devtoken",
      MINIONS_PROVIDER: "mock",
      MINIONS_PORT: "8801",
      MINIONS_HOST: "127.0.0.1",
      MINIONS_WORKSPACE: "./.e2e-workspace",
      MINIONS_SERVE_WEB: "true",
      MINIONS_WEB_DIST: "./dist",
      MINIONS_CORS_ORIGINS: "http://127.0.0.1:8801",
    },
    port: 8801,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
