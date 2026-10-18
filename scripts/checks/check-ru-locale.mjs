#!/usr/bin/env node
/**
 * Ratchet: hard-coded "ru-RU" locale literals. Formatting must go through src/lib/format + src/i18n/format
 * (ARCHITECTURE.md §1 rule 6), which pick the locale from the current UI language.
 * The i18n/format modules themselves are excluded (they own the language → locale mapping). Tests are excluded.
 *
 *   node scripts/checks/check-ru-locale.mjs [--list | --update | --force]
 */
import fs from "node:fs";
import path from "node:path";
import { REPO, isTestFile, ratchet, rel, walk } from "./lib/ratchet.mjs";

const RE = /(["'`])ru-RU\1/g;
const OWNERS = [/\/src\/i18n\//, /\/src\/lib\/format(\/|\.ts$)/];

function scan(pkg) {
  const counts = {};
  for (const f of walk(path.join(REPO, "artifacts", pkg, "src"), /\.(tsx?|mts)$/)) {
    const r = rel(f);
    if (isTestFile(f) || OWNERS.some((o) => o.test(`/${r}`))) continue;
    const n = (fs.readFileSync(f, "utf8").match(RE) ?? []).length;
    if (n) counts[r] = n;
  }
  return counts;
}

ratchet({
  name: "check-ru-locale",
  mode: "total",
  description: '"ru-RU" string literals outside src/i18n and src/lib/format',
  metrics: { web: scan("edge-tracker"), api: scan("api-server") },
  hint: "use the formatters from src/lib/format / src/i18n/format instead of new Intl.*(\"ru-RU\") or toLocale*(\"ru-RU\")",
});
