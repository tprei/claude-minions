import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@minions/shared": fileURLToPath(new URL("../shared/dist/index.js", import.meta.url)),
    },
  },
  test: {
    environment: "happy-dom",
    include: [
      "src/**/__tests__/**/*.test.{ts,tsx}",
      "src/**/*.test.{ts,tsx}",
    ],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
