import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/pwa/**"],
        },
      },
      {
        test: {
          name: "pwa",
          environment: "jsdom",
          include: ["test/pwa/**/*.test.ts"],
        },
      },
    ],
  },
});
