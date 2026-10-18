#!/usr/bin/env node
/**
 * i18n progress report: Cyrillic text that still lives in code instead of a dictionary.
 *
 * Counts Cyrillic string literals, template-literal text and JSX text (TypeScript AST, so comments and regex
 * literals are never counted) in src/**, except:
 *   - src/i18n/locales/** (dictionaries) and the i18n docs,
 *   - tests (*.test.ts(x), __tests__/),
 *   - lines carrying an `i18n-ignore` comment on the same or the previous line (e.g. Russian-input parsing),
 *   - `keywords:` / `searchTerms:` / `aliases:` property values (hidden search synonyms, not UI text),
 *   - entries of src/i18n/allowlist.json: { "files": [regex on path], "literals": [regex on text] }.
 *
 *   pnpm run i18n:report                         per-area totals + top files
 *   pnpm run i18n:report -- --files              every file with its count
 *   pnpm run i18n:report -- --path src/pages/trades.tsx --list   every hit (line + text) under a path prefix
 *   pnpm run i18n:report -- --check src/components/trades        exit 1 if anything is left under the prefix
 *   pnpm run i18n:report -- --freq 200           most frequent literals (to see what belongs in `common`)
 *   pnpm run i18n:report -- --json               machine-readable output
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "src");
const ALLOWLIST = path.join(SRC, "i18n", "allowlist.json");

const CYR = /[Ѐ-ӿ]/;
const SKIP_PATH = [/^src\/i18n\/locales\//, /\.test\.tsx?$/, /\/__tests__\//, /\.d\.ts$/];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

function readAllowlist() {
  try {
    const j = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8"));
    return { files: (j.files ?? []).map((s) => new RegExp(s)), literals: (j.literals ?? []).map((s) => new RegExp(s)) };
  } catch (err) {
    if (err?.code !== "ENOENT") console.error(`i18n-report: cannot read ${path.relative(ROOT, ALLOWLIST)}: ${err.message}`);
    return { files: [], literals: [] };
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts|cts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Area = the first two meaningful path segments: components/trades, pages/trades.tsx → pages/trades, lib, hooks… */
function areaOf(rel) {
  const parts = rel.replace(/^src\//, "").split("/");
  if (parts[0] === "components" || parts[0] === "pages") {
    if (parts.length === 2) return `${parts[0]}/${parts[1].replace(/\.(tsx?|mts)$/, "")}`;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts.length > 1 ? parts[0] : "(root)";
}

function isKeywordsProp(node) {
  const p = node.parent;
  return !!p && ts.isPropertyAssignment(p) && p.initializer === node && /^(keywords|searchTerms|aliases)$/.test(p.name.getText());
}

function scanFile(file, rel, allow) {
  const text = fs.readFileSync(file, "utf8");
  if (!CYR.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const hits = [];
  const push = (node, value) => {
    const v = value.replace(/\s+/g, " ").trim();
    if (!v || !CYR.test(v)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if (/i18n-ignore/.test(lines[line] ?? "") || /i18n-ignore/.test(lines[line - 1] ?? "")) return;
    if (allow.literals.some((r) => r.test(v))) return;
    hits.push({ line: line + 1, text: v });
  };
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        // Skip module specifiers and search synonyms (`keywords: "…"` — hidden match terms, not UI text).
        if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent) && !isKeywordsProp(node)) push(node, node.text);
        break;
      case ts.SyntaxKind.TemplateExpression: {
        if (isKeywordsProp(node)) return;
        const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("{…}");
        push(node, parts);
        node.templateSpans.forEach((s) => visit(s.expression));
        return;
      }
      case ts.SyntaxKind.JsxText:
        push(node, node.text);
        break;
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const allow = readAllowlist();
const prefix = opt("--path") ?? opt("--check");
const results = [];
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (SKIP_PATH.some((r) => r.test(rel))) continue;
  if (allow.files.some((r) => r.test(rel))) continue;
  if (prefix && !rel.startsWith(prefix)) continue;
  const hits = scanFile(file, rel, allow);
  if (hits.length) results.push({ file: rel, area: areaOf(rel), count: hits.length, hits });
}
results.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

const total = results.reduce((s, r) => s + r.count, 0);
const areas = new Map();
for (const r of results) {
  const a = areas.get(r.area) ?? { area: r.area, files: 0, count: 0 };
  a.files++; a.count += r.count; areas.set(r.area, a);
}
const areaList = [...areas.values()].sort((a, b) => b.count - a.count);

if (flag("--json")) {
  console.log(JSON.stringify({ total, files: results.length, areas: areaList, results: results.map(({ hits, ...r }) => (flag("--list") ? { ...r, hits } : r)) }, null, 2));
} else if (opt("--freq")) {
  const freq = new Map();
  for (const r of results) for (const h of r.hits) freq.set(h.text, (freq.get(h.text) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(opt("--freq")) || 100);
  for (const [t, n] of top) console.log(`${String(n).padStart(5)}  ${t}`);
} else {
  console.log(`i18n report (edge-tracker): ${total} Cyrillic literals in ${results.length} files${prefix ? ` under ${prefix}` : ""}\n`);
  console.log("By area:");
  for (const a of areaList) console.log(`  ${String(a.count).padStart(6)}  ${a.area}  (${a.files} files)`);
  const showAll = flag("--files") || flag("--list") || !!prefix;
  const list = showAll ? results : results.slice(0, 25);
  console.log(`\n${showAll ? "Files" : "Top 25 files"}:`);
  for (const r of list) {
    console.log(`  ${String(r.count).padStart(6)}  ${r.file}`);
    if (flag("--list")) for (const h of r.hits) console.log(`          ${String(h.line).padStart(5)}: ${h.text.slice(0, 120)}`);
  }
}

if (opt("--check") && total > 0) {
  console.error(`\n✗ ${total} Cyrillic literal(s) left under ${opt("--check")}`);
  process.exit(1);
}
