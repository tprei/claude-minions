import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".dev-workspace/**",
      ".workspace/**",
      ".local-workspace/**",
      "coverage/**",
      "**/dev-dist/**",
      "**/.vite/**",
      "packages/web/dev-dist/**",
      "packages/engine/pwa/**",
      "packages/engine/test/fixtures/pwa-*/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "packages/*/scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    files: [
      "packages/*/src/**/*.{ts,tsx}",
      "packages/*/test/**/*.{ts,tsx}",
      "packages/*/tests-e2e/**/*.{ts,tsx}",
      "packages/*/scripts/**/*.ts",
      "packages/*/playwright.config.ts",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { project: false },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-useless-assignment": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-extra-boolean-cast": "warn",
      "prefer-const": "warn",
      "preserve-caught-error": "off",
    },
  },
];
