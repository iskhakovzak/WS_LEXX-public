/**
 * Splits a SQL script into top-level statements on `;`, respecting single-quoted strings, double-quoted identifiers,
 * dollar-quoted bodies ($$ … $$, $tag$ … $tag$), line comments and block comments. Used only for `-- no-transaction`
 * migrations, where each statement must run on its own (CREATE INDEX CONCURRENTLY refuses a multi-statement query).
 * Pure, no I/O.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end + 1;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; } // escaped '' or ""
          break;
        }
        j++;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (hasCode(buf)) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (hasCode(buf)) out.push(buf.trim());
  return out;
}

/** True when the fragment contains something other than whitespace and comments. */
function hasCode(s: string): boolean {
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().length > 0;
}
