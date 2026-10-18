// ESLint runs ONLY the rules Biome cannot express (see biome.json for everything else):
//  - react-hooks/exhaustive-deps: the codebase already carries ~90 intentional `eslint-disable… react-hooks/exhaustive-deps`
//    suppressions; Biome's useExhaustiveDependencies ignores them and also flags extra deps, so the hooks deps check lives here.
//  - @tanstack/query/*: query-key completeness, rest destructuring, stable QueryClient — no Biome equivalent.
// Everything is "warn" and ratcheted by scripts/checks/check-lint.mjs (counts may only go down).
// React Compiler rules (react-hooks v7 "recommended") are deliberately off until the compiler is adopted (phase F).
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import pluginQuery from "@tanstack/eslint-plugin-query";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "node_modules/**", "scripts/**", "**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    // @typescript-eslint is registered (no rules on) so existing `eslint-disable @typescript-eslint/*` comments resolve.
    plugins: { "@typescript-eslint": tsPlugin, "react-hooks": reactHooks, "@tanstack/query": pluginQuery },
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "@tanstack/query/exhaustive-deps": "warn",
      "@tanstack/query/no-rest-destructuring": "warn",
      "@tanstack/query/stable-query-client": "warn",
      "@tanstack/query/no-unstable-deps": "warn",
      "@tanstack/query/infinite-query-property-order": "warn",
      "@tanstack/query/mutation-property-order": "warn",
    },
  },
];
