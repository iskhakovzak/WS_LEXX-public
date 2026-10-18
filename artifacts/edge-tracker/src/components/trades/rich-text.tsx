import * as React from "react";

/**
 * Put React nodes into a translated sentence without gluing fragments: translate with the node slots passed through
 * as their own placeholders, then swap them for nodes.
 *
 *   withNodes(t("related.historyStats", { trades, wr: "{wr}", r: "{r}" }), { wr: <b>{fmtRate(x)}</b>, r: <b>{fmtR(y)}</b> })
 */
export function withNodes(text: string, nodes: Record<string, React.ReactNode>): React.ReactNode {
  const parts = text.split(/\{(\w+)\}/);
  return parts.map((part, i) => (i % 2 === 1 ? <React.Fragment key={i}>{part in nodes ? nodes[part] : `{${part}}`}</React.Fragment> : part));
}
