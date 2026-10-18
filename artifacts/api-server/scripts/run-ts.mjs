// Runs a TypeScript entry of the API server without tsx: bundles it with esbuild (already a devDependency) into
// node_modules/.cache/run-ts/ and imports it. Usage: node scripts/run-ts.mjs src/db/tools/snapshot.ts [args…]
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.argv[2];
if (!entry) {
  console.error("usage: node scripts/run-ts.mjs <entry.ts> [args…]");
  process.exit(2);
}
const outfile = path.join(root, "node_modules", ".cache", "run-ts", path.basename(entry).replace(/\.ts$/, ".mjs"));
globalThis.require = createRequire(import.meta.url);
await build({
  entryPoints: [path.resolve(root, entry)],
  outfile,
  platform: "node",
  format: "esm",
  bundle: true,
  logLevel: "warning",
  external: ["pg-native"],
  banner: {
    js: `import { createRequire as __crReq } from 'node:module'; globalThis.require = __crReq(import.meta.url);`,
  },
});
process.argv.splice(2, 1);
await import(pathToFileURL(outfile).href);
