#!/usr/bin/env node
/**
 * Layer-scale lint: z-index must come from the tokens in src/index.css
 * (z-raised / z-sticky / z-sticky-corner / z-header / z-nav / z-sheet / z-modal / z-popover / z-toast / z-tooltip / z-skip),
 * never from raw Tailwind numbers (`z-10`, `z-50`, `z-[9999]`) or raw `z-index: 40` in CSS.
 *
 *   node scripts/check-z.mjs            report + exit 1 on violations that are not in the baseline
 *   node scripts/check-z.mjs --all      list every violation (baseline included)
 *   node scripts/check-z.mjs --update   rewrite the baseline (only shrinks it: counts never go up)
 *
 * The baseline (scripts/check-z.baseline.json) is a ratchet for files that still use raw values: a file may
 * keep at most its recorded count, new files must be clean. Fix a file → run --update so the debt stays paid.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "src");
const BASELINE = path.join(HERE, "check-z.baseline.json");

// Tailwind class: z-10, -z-10, z-[9999], z-[calc(...)] — preceded by start/space/quote/colon (variants like lg:z-20).
const TW_RAW = /(?<=^|[\s"'`:{(!])-?z-(\d+|\[(?!var\(--z-|calc\(var\(--z-)[^\]]+\])(?![\w-])/g;
// CSS: z-index: 40 (allow -1 / 0 / 1: local stacking inside an isolated component).
const CSS_RAW = /z-index:\s*(-?\d+)/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** @returns {{file:string,line:number,match:string}[]} */
export function scanZ(root = SRC) {
  const hits = [];
  for (const file of walk(root)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      if (/check-z-ignore/.test(text)) return;
      if (file.endsWith(".css")) {
        for (const m of text.matchAll(CSS_RAW)) {
          const n = Number(m[1]);
          if (n < -1 || n > 1) hits.push({ file: rel, line: i + 1, match: m[0] });
        }
      } else {
        for (const m of text.matchAll(TW_RAW)) hits.push({ file: rel, line: i + 1, match: m[0] });
      }
    });
  }
  return hits;
}

export function readBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  } catch {
    return {};
  }
}

export function countByFile(hits) {
  const c = {};
  for (const h of hits) c[h.file] = (c[h.file] ?? 0) + 1;
  return c;
}

/** Violations beyond the baseline (new files, or more raw values than recorded). */
export function newViolations(hits = scanZ(), baseline = readBaseline()) {
  const counts = countByFile(hits);
  return Object.entries(counts)
    .filter(([f, n]) => n > (baseline[f] ?? 0))
    .flatMap(([f]) => hits.filter((h) => h.file === f).map((h) => ({ ...h, allowed: baseline[f] ?? 0, found: counts[f] })));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const hits = scanZ();
  const baseline = readBaseline();
  if (args.has("--update")) {
    const counts = countByFile(hits);
    const next = {};
    for (const [f, n] of Object.entries(counts)) {
      // ratchet: never raise an existing allowance; new files are only added on purpose (first run / empty baseline)
      const prev = baseline[f];
      if (prev == null && Object.keys(baseline).length) continue;
      next[f] = prev == null ? n : Math.min(prev, n);
    }
    fs.writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(next).sort()), null, 2) + "\n");
    console.log(`check-z: baseline updated (${Object.keys(next).length} files, ${Object.values(next).reduce((a, b) => a + b, 0)} raw values left)`);
    return;
  }
  if (args.has("--all")) {
    for (const h of hits) console.log(`${h.file}:${h.line}  ${h.match}`);
    console.log(`check-z: ${hits.length} raw z-index values in ${Object.keys(countByFile(hits)).length} files`);
  }
  const bad = newViolations(hits, baseline);
  if (bad.length) {
    console.error("check-z: raw z-index values — use z-raised / z-sticky / z-header / z-nav / z-sheet / z-modal / z-popover / z-toast / z-tooltip:");
    for (const h of bad) console.error(`  ${h.file}:${h.line}  ${h.match}   (file allows ${h.allowed}, found ${h.found})`);
    process.exit(1);
  }
  const left = Object.values(baseline).reduce((a, b) => a + b, 0);
  console.log(`check-z: ok (${hits.length} raw values remain, all in the baseline${left ? `: ${left} allowed` : ""})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
