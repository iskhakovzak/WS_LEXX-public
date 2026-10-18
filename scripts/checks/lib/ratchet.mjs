/**
 * Shared ratchet runner for scripts/checks/check-*.mjs (same idea as edge-tracker/scripts/check-z.mjs).
 *
 * A check measures one or more metrics, each a map { key → count } (key = file, rule, function…), and compares
 * them with a committed baseline in scripts/checks/baselines/<name>.json:
 *
 *   mode "total"    the metric's total may not grow (debt may move between files, it may not increase);
 *   mode "per-key"  no key may exceed its recorded count, and keys missing from the baseline must be 0
 *                   (used for sizes: an offender may not grow, a new offender fails).
 *
 * Flags (every check accepts them):
 *   --list     print every key with its count
 *   --update   shrink the baseline to the current numbers (never raises a number, never adds a key)
 *   --force    overwrite the baseline with the current numbers (deliberate reset; say why in the commit)
 *
 * Without a baseline file the first run writes one and passes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASELINES = path.join(REPO, "scripts", "checks", "baselines");

export const toPosix = (p) => p.split(path.sep).join("/");
export const rel = (p) => toPosix(path.relative(REPO, p));

/** Recursively list files under `dir` whose name matches `re`, skipping node_modules, dist and dot-folders. */
export function walk(dir, re, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

export const isTestFile = (p) => /\.test\.tsx?$|[\\/]__tests__[\\/]|[\\/]test-setup\.ts$/.test(p);

const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);
const sortObj = (o) => Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)));

function readBaseline(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function writeBaseline(file, name, mode, description, metrics) {
  const out = { check: name, mode, description, metrics: {} };
  for (const [m, byKey] of Object.entries(metrics)) out.metrics[m] = { total: sum(byKey), byKey: sortObj(byKey) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

/**
 * @param {object} o
 * @param {string} o.name           baseline file name (without .json)
 * @param {"total"|"per-key"} o.mode
 * @param {string} o.description    one line: what is counted and why it must shrink
 * @param {Record<string, Record<string, number>>} o.metrics
 * @param {string} [o.hint]         printed on failure: how to fix
 * @param {number} [o.slack]        per-key mode only: an existing key may exceed its recorded count by this much
 *                                  (e.g. a codemod adding an import line to a big file); new keys get no slack
 */
export function ratchet({ name, mode, description, metrics, hint, slack = 0 }) {
  const args = new Set(process.argv.slice(2));
  const file = path.join(BASELINES, `${name}.json`);
  const base = readBaseline(file);

  if (args.has("--list")) {
    for (const [m, byKey] of Object.entries(metrics)) {
      console.log(`${name}/${m}: ${sum(byKey)}`);
      for (const [k, n] of Object.entries(byKey).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
    }
  }

  if (!base || args.has("--force")) {
    writeBaseline(file, name, mode, description, metrics);
    const totals = Object.entries(metrics).map(([m, k]) => `${m}=${sum(k)}`).join(", ");
    console.log(`${name}: baseline ${base ? "reset" : "created"} (${totals}) → ${rel(file)}`);
    return;
  }

  if (args.has("--update")) {
    const next = {};
    for (const [m, byKey] of Object.entries(metrics)) {
      const prev = base.metrics?.[m];
      if (!prev) {
        next[m] = byKey;
        continue;
      }
      if (mode === "total") {
        // keep the per-key detail current, but the total only ever shrinks
        next[m] = sum(byKey) <= prev.total ? byKey : prev.byKey;
      } else {
        next[m] = {};
        for (const [k, n] of Object.entries(prev.byKey)) next[m][k] = Math.min(n, byKey[k] ?? 0);
      }
    }
    writeBaseline(file, name, mode, description, next);
    console.log(`${name}: baseline updated → ${Object.entries(next).map(([m, k]) => `${m}=${sum(k)}`).join(", ")}`);
    return;
  }

  const failures = [];
  const summary = [];
  for (const [m, byKey] of Object.entries(metrics)) {
    const prev = base.metrics?.[m] ?? { total: 0, byKey: {} };
    const cur = sum(byKey);
    summary.push(mode === "total" ? `${m} ${cur}/${prev.total}` : `${m} ${Object.keys(byKey).length}/${Object.keys(prev.byKey).length} offenders`);
    if (mode === "total") {
      if (cur > prev.total) {
        const grown = Object.entries(byKey)
          .map(([k, n]) => [k, n - (prev.byKey[k] ?? 0)])
          .filter(([, d]) => d > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15);
        failures.push(`${m}: ${cur} > baseline ${prev.total} (+${cur - prev.total})`);
        for (const [k, d] of grown) failures.push(`    +${d}  ${k}`);
      }
    } else {
      for (const [k, n] of Object.entries(byKey)) {
        const allowed = prev.byKey[k] ?? 0;
        if (allowed === 0 ? n > 0 : n > allowed + slack) {
          failures.push(`${m}: ${k}  ${n} > ${allowed}${allowed ? (slack ? ` (+${slack} slack)` : "") : " (new offender)"}`);
        }
      }
    }
  }

  if (failures.length) {
    console.error(`✗ ${name}: the number grew (ratchet).`);
    for (const f of failures) console.error(`  ${f}`);
    if (hint) console.error(`  → ${hint}`);
    console.error(`  If the growth is intended (e.g. a file was renamed), run: node scripts/checks/${name}.mjs --force  and explain it in the commit.`);
    process.exit(1);
  }
  const shrunk = Object.entries(metrics).some(([m, k]) => sum(k) < (base.metrics?.[m]?.total ?? 0));
  console.log(`✓ ${name}: ${summary.join(", ")} (current/baseline)${shrunk ? " — debt went down, run with --update to lock it in" : ""}`);
}
