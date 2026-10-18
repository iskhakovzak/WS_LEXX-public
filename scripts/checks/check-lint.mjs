#!/usr/bin/env node
/**
 * Ratchet: lint findings per rule. Biome (biome.json, whole repo) and ESLint (artifacts/edge-tracker/eslint.config.mjs:
 * react-hooks deps + TanStack Query) report most rules as warnings so the existing code passes; this check makes
 * sure no rule's count grows. Biome errors still fail `pnpm lint` directly.
 *
 *   node scripts/checks/check-lint.mjs [--list | --update | --force]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { REPO, ratchet, toPosix } from "./lib/ratchet.mjs";

// Run the CLIs' JS entry points with the current node (no shell, works the same on Windows and Linux).
const BIOME = path.join(REPO, "node_modules", "@biomejs", "biome", "bin", "biome");
const ESLINT = path.join(REPO, "artifacts", "edge-tracker", "node_modules", "eslint", "bin", "eslint.js");

function run(script, args, cwd) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r.stdout;
}

function biome() {
  const out = run(BIOME, ["lint", "--reporter=json", "--max-diagnostics=none", "."], REPO);
  const j = JSON.parse(out.slice(out.indexOf("{")));
  const counts = {};
  for (const d of j.diagnostics ?? []) {
    if (d.severity === "info" && d.category === "deserialize") continue;
    if (d.category === "parse") continue; // syntax errors already fail `pnpm lint`; never part of a baseline
    counts[d.category] = (counts[d.category] ?? 0) + 1;
  }
  return counts;
}

function eslint() {
  const cwd = path.join(REPO, "artifacts", "edge-tracker");
  const out = run(ESLINT, ["src", "-f", "json", "--cache", "--cache-location", "node_modules/.cache/eslint/"], cwd);
  const counts = {};
  for (const file of JSON.parse(out)) {
    for (const m of file.messages) {
      const k = m.ruleId ?? (m.fatal ? "parse-error" : "unknown");
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  return counts;
}

ratchet({
  name: "check-lint",
  mode: "per-key",
  description: "lint findings per rule (Biome + ESLint); no rule may gain findings",
  metrics: { biome: biome(), eslint: eslint() },
  hint: `run \`pnpm lint\` (or biome lint <file> / eslint <file> in ${toPosix("artifacts/edge-tracker")}) and fix the new findings in the files you touched`,
});
