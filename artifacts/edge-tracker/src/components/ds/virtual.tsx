/**
 * Windowing for long lists (uses @tanstack/react-virtual, already a dependency).
 *
 * Tables — inside <DataTable maxHeight=…> (it provides the scroll element through context):
 *   <DataTable maxHeight="70vh" ariaLabel="Сделки">
 *     <table>
 *       <thead>…</thead>
 *       <VirtualRows rows={rows} colSpan={9} estimateSize={41} getKey={(r) => r.id}
 *         renderRow={(r) => <TradeRow key={r.id} trade={r} />} />
 *     </table>
 *   </DataTable>
 * Below `threshold` rows (default 120) everything renders normally — no behaviour change for short tables.
 * renderRow must return a single <tr> with a key.
 *
 * Div lists (feeds, cards):
 *   <VirtualList items={items} estimateSize={72} maxHeight="70vh" renderItem={(it) => <Card … />} />
 */
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

/** Scroll element of the nearest DataTable (null outside of one). */
export const ScrollContainerContext = React.createContext<React.RefObject<HTMLElement | null> | null>(null);

export function VirtualRows<Row>({
  rows,
  renderRow,
  estimateSize = 41,
  overscan = 12,
  threshold = 120,
  colSpan,
  getKey,
  className,
}: {
  rows: readonly Row[];
  renderRow: (row: Row, index: number) => React.ReactNode;
  /** Row height in px (compact DataTable row ≈ 41). */
  estimateSize?: number;
  overscan?: number;
  /** Virtualize only from this many rows. */
  threshold?: number;
  /** Number of columns (for the spacer rows). */
  colSpan: number;
  getKey?: (row: Row, index: number) => React.Key;
  className?: string;
}) {
  const scrollRef = React.useContext(ScrollContainerContext);
  const enabled = rows.length >= threshold && !!scrollRef;
  const virtualizer = useVirtualizer({
    count: enabled ? rows.length : 0,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: getKey ? (i) => getKey(rows[i], i) : undefined,
  });

  if (!enabled) {
    return <tbody className={className}>{rows.map((r, i) => renderRow(r, i))}</tbody>;
  }

  const items = virtualizer.getVirtualItems();
  const total = virtualizer.getTotalSize();
  const top = items.length ? items[0].start : 0;
  const bottom = items.length ? total - items[items.length - 1].end : 0;
  return (
    <tbody className={className}>
      {top > 0 && (
        <tr aria-hidden="true" style={{ height: top }}>
          <td colSpan={colSpan} style={{ padding: 0, border: 0 }} />
        </tr>
      )}
      {items.map((vi) => renderRow(rows[vi.index], vi.index))}
      {bottom > 0 && (
        <tr aria-hidden="true" style={{ height: bottom }}>
          <td colSpan={colSpan} style={{ padding: 0, border: 0 }} />
        </tr>
      )}
    </tbody>
  );
}

export function VirtualList<Item>({
  items,
  renderItem,
  estimateSize = 64,
  overscan = 8,
  threshold = 60,
  maxHeight = "70vh",
  gap = 8,
  getKey,
  className,
  ariaLabel,
}: {
  items: readonly Item[];
  renderItem: (item: Item, index: number) => React.ReactNode;
  estimateSize?: number;
  overscan?: number;
  threshold?: number;
  maxHeight?: number | string;
  /** Vertical gap between items in px. */
  gap?: number;
  getKey?: (item: Item, index: number) => React.Key;
  className?: string;
  ariaLabel?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const enabled = items.length >= threshold;
  const virtualizer = useVirtualizer({
    count: enabled ? items.length : 0,
    getScrollElement: () => ref.current,
    estimateSize: () => estimateSize + gap,
    overscan,
    getItemKey: getKey ? (i) => getKey(items[i], i) : undefined,
  });

  if (!enabled) {
    return (
      <div role={ariaLabel ? "list" : undefined} aria-label={ariaLabel} className={cn("flex flex-col", className)} style={{ gap }}>
        {items.map((it, i) => (
          <div role={ariaLabel ? "listitem" : undefined} key={getKey ? getKey(it, i) : i}>{renderItem(it, i)}</div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      role="list"
      aria-label={ariaLabel}
      tabIndex={0}
      className={cn("relative overflow-y-auto overscroll-contain", className)}
      style={{ maxHeight }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            role="listitem"
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 top-0"
            style={{ transform: `translateY(${vi.start}px)`, paddingBottom: gap }}
          >
            {renderItem(items[vi.index], vi.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
