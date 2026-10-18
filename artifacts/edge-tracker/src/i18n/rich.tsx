/**
 * Rich text from a translated string: put React nodes (bold term, link, <Kbd>) where a {placeholder} stands, so a
 * sentence stays one dictionary entry instead of glued fragments.
 *
 *   // dictionary: create: "Создать тег «{term}»"
 *   rich(t("tagPicker.create", slots("term")), { term: <b>{term}</b> })
 *
 * `slots(...)` passes each placeholder through as "{name}" (t() requires its params), `rich()` then swaps them for
 * the nodes. Placeholders without a node stay as text. (Passing `{ term: "{term}" }` by hand works the same.)
 */
import { Fragment, type ReactNode } from "react";

export function slots<K extends string>(...names: K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const n of names) out[n] = `{${n}}`;
  return out;
}

export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const parts = text.split(/(\{[a-zA-Z0-9_]+\})/g);
  return parts.map((p, i) => {
    const m = /^\{([a-zA-Z0-9_]+)\}$/.exec(p);
    if (m && m[1] in nodes) return <Fragment key={i}>{nodes[m[1]]}</Fragment>;
    return p ? <Fragment key={i}>{p}</Fragment> : null;
  });
}
