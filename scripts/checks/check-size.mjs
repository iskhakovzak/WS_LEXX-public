#!/usr/bin/env node
/**
 * Ratchet: oversized files and functions (ARCHITECTURE.md §1 rule 10: a component function ≤ 300 lines,
 * a file ≤ 600 lines). Existing offenders are recorded with their current size and may only shrink;
 * a new offender fails. Applies to artifacts/{edge-tracker,api-server}/src, tests excluded. Translation dictionaries
 * (web src/i18n/locales/**, api src/i18n/{ru,en,uz}/**) are data, not code, and are skipped.
 * Function = function declaration / expression / arrow / method, named after its binding (nested: outer>inner).
 *
 *   node scripts/checks/check-size.mjs [--list | --update | --force]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { REPO, isTestFile, ratchet, rel, walk } from "./lib/ratchet.mjs";

const ts = createRequire(path.join(REPO, "package.json"))("typescript");
const MAX_FILE = 600;
const MAX_FN = 300;
const SLACK = 10;

function fnName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.name && ts.isStringLiteral(node.name)) return node.name.text;
  // const X = () => …  /  const X = memo(function …)  /  { key: () => … }
  for (let p = node.parent; p; p = p.parent) {
    // router.get("/path", async (req, res) => …) → "get /path"
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.arguments[0] && ts.isStringLiteralLike(p.arguments[0])) {
      return `${p.expression.name.text} ${p.arguments[0].text}`;
    }
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
    if (ts.isExportAssignment(p)) return "default";
    if (!ts.isCallExpression(p) && !ts.isParenthesizedExpression(p) && !ts.isAsExpression(p)) break;
  }
  return "<anonymous>";
}

function scanFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).length;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const fns = [];
  const seen = new Map();
  const visit = (node, chain) => {
    let next = chain;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const name = [...chain, fnName(node)].join(">");
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      const len = end - start + 1;
      if (len > MAX_FN) {
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        fns.push([n > 1 ? `${name}#${n}` : name, len]);
      }
      next = [...chain, fnName(node)];
    }
    ts.forEachChild(node, (c) => visit(c, next));
  };
  visit(sf, []);
  return { lines, fns };
}

const metrics = {};
for (const [pkg, short] of [["edge-tracker", "web"], ["api-server", "api"]]) {
  const files = {};
  const functions = {};
  for (const f of walk(path.join(REPO, "artifacts", pkg, "src"), /\.(tsx?|mts)$/)) {
    if (isTestFile(f) || f.endsWith(".d.ts")) continue;
    const r = rel(f);
    if (/\/src\/i18n\/(locales\/)?(ru|en|uz)\//.test(r)) continue; // dictionaries: data, not code
    const { lines, fns } = scanFile(f);
    if (lines > MAX_FILE) files[r] = lines;
    for (const [name, len] of fns) functions[`${r}#${name}`] = len;
  }
  metrics[`${short}-files>${MAX_FILE}`] = files;
  metrics[`${short}-functions>${MAX_FN}`] = functions;
}

ratchet({
  name: "check-size",
  mode: "per-key",
  description: `files over ${MAX_FILE} lines and functions over ${MAX_FN} lines (values = current line counts; may only shrink)`,
  metrics,
  slack: SLACK,
  hint: "split the file/component instead of growing it (extract a sub-component, a hook or a pure model.ts)",
});
