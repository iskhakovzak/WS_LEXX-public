#!/usr/bin/env node
/**
 * Ratchet: Cyrillic UI text still hard-coded in code instead of the i18n dictionaries (RU/EN/UZ).
 * Counts come from the existing reports (artifacts/{edge-tracker,api-server}/scripts/i18n-report.mjs — same
 * exclusions: dictionaries, tests, `i18n-ignore`, allowlist.json). The total per package may only go down.
 *
 *   node scripts/checks/check-i18n.mjs [--list | --update | --force]
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { REPO, ratchet } from "./lib/ratchet.mjs";

function report(pkg) {
  const cwd = path.join(REPO, "artifacts", pkg);
  const out = execFileSync(process.execPath, ["scripts/i18n-report.mjs", "--json"], { cwd, maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out.toString("utf8"));
  return Object.fromEntries(j.results.map((r) => [r.file, r.count]));
}

ratchet({
  name: "check-i18n",
  mode: "total",
  description: "Cyrillic literals in code outside i18n dictionaries (per package total may only shrink)",
  metrics: { web: report("edge-tracker"), api: report("api-server") },
  hint: "move new user-facing text into src/i18n (all three languages); see artifacts/edge-tracker/src/i18n/README.md",
});
