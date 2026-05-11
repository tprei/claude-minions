import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@minions/shared": fileURLToPath(new URL("../shared/dist/index.js", import.meta.url)),
      "@minions/engine-next": fileURLToPath(new URL("../engine-next/src/index.ts", import.meta.url)),
    },
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
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
