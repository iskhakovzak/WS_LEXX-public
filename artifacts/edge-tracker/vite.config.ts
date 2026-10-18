import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
// Enforced script CSP <meta> in the built index.html (the full policy is a report-only header from the API).
import { cspMeta } from "./scripts/csp-meta.mjs";

const rawPort = process.env.PORT || "5000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || "/";

const onReplit = process.env.REPL_ID !== undefined;
const devHost = process.env.VITE_HOST || (onReplit ? "0.0.0.0" : "localhost");

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    cspMeta(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    // Replit's preview proxy needs every interface and any host; locally the dev server (which can read
    // .env files) stays on this machine. VITE_HOST overrides both.
    host: devHost,
    allowedHosts: onReplit ? true : undefined,
    proxy: {
      "/api": {
        // API_TARGET lets a second dev server (own port = own localStorage session) talk to another API instance.
        target: process.env.API_TARGET || "http://localhost:8080",
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: devHost,
    allowedHosts: onReplit ? true : undefined,
  },
});
