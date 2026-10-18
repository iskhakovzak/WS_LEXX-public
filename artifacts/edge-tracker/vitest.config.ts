import { defineConfig } from "vitest/config";
import path from "path";

// Node env, no DOM: pure-lib tests plus server-rendered component tests (react-dom/server). The `@/` alias mirrors
// vite.config.ts; components compile with the automatic JSX runtime like the app build.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
