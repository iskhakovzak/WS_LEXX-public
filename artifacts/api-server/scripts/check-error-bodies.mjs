#!/usr/bin/env node
/**
 * Ratchet: hand-written error bodies outside src/lib/http (ARCHITECTURE §2 rule 2).
 *
 * Counts, per file under src/ (tests and src/lib/http excluded), the `json(` calls that are either
 *   `.status(4xx|5xx).json(`   or   `json({ error: …`
 * (one call counted once). New code throws AppError (src/lib/http/errors.ts); the error middleware writes the body.
 *
 *   node scripts/check-error-bodies.mjs            check against the baseline: exit 1 if any file grew or a new file appeared
 *   node scripts/check-error-bodies.mjs --update   rewrite the baseline (after converting sites; never to hide new ones)
 *   node scripts/check-error-bodies.mjs --list src/routes/trades.ts   every remaining site in a file / under a prefix
 *
 * Baseline: scripts/error-bodies.baseline.json { total, files: { "src/routes/x.ts": n } }.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "src");
const BASELINE = path.join(HERE, "error-bodies.baseline.json");
const SKIP = [/^src\/lib\/http\//, /\.test\.ts$/, /\/__tests__\//, /\.d\.ts$/];

const STATUS_JSON = /\.status\(\s*[45]\d\d\s*\)\s*\.json\(/g;
const JSON_ERROR = /\bjson\(\s*\{\s*error\s*:/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Positions (index of the `json(` token) of every counted call in `text`. */
export function errorBodySites(text) {
  const at = new Set();
  for (const m of text.matchAll(STATUS_JSON)) at.add(m.index + m[0].lastIndexOf("json("));
  for (const m of text.matchAll(JSON_ERROR)) at.add(m.index + m[0].indexOf("json("));
  return [...at].sort((a, b) => a - b);
}

function scan() {
  const files = {};
  let total = 0;
  const sites = {};
  for (const abs of walk(SRC)) {
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    if (SKIP.some((r) => r.test(rel))) continue;
    const text = fs.readFileSync(abs, "utf8");
    const pos = errorBodySites(text);
    if (!pos.length) continue;
    files[rel] = pos.length;
    total += pos.length;
    sites[rel] = pos.map((i) => {
      const line = text.slice(0, i).split("\n").length;
      return { line, text: text.split("\n")[line - 1].trim().slice(0, 160) };
    });
  }
  return { total, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))), sites };
}

const args = process.argv.slice(2);
const now = scan();

if (args.includes("--list")) {
  const prefix = args[args.indexOf("--list") + 1] ?? "src/";
  for (const [file, list] of Object.entries(now.sites)) {
    if (!file.startsWith(prefix)) continue;
    for (const s of list) console.log(`${file}:${s.line}  ${s.text}`);
  }
  process.exit(0);
}

if (args.includes("--update")) {
  fs.writeFileSync(BASELINE, JSON.stringify({ total: now.total, files: now.files }, null, 2) + "\n");
  console.log(`error-bodies: baseline written — ${now.total} sites in ${Object.keys(now.files).length} files`);
  process.exit(0);
}

let base;
try {
  base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
} catch {
  console.error("error-bodies: no baseline — run with --update first");
  process.exit(1);
}

const grew = [];
for (const [file, n] of Object.entries(now.files)) {
  const was = base.files[file] ?? 0;
  if (n > was) grew.push(`${file}: ${was} → ${n}`);
}
if (grew.length) {
  console.error("error-bodies: hand-written error responses grew. Throw AppError instead (src/lib/http/README.md):");
  for (const g of grew) console.error(`  ${g}`);
  process.exit(1);
}
const shrunk = base.total - now.total;
console.log(`error-bodies: ${now.total} sites (baseline ${base.total})${shrunk > 0 ? ` — ${shrunk} fewer, run --update to lock it in` : ""}`);
