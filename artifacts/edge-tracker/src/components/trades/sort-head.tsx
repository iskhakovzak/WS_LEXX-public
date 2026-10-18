// Sortable header cell for CSS-grid "tables" (role=row/columnheader). Same look as ds `SortableTh`, which needs a <th>.
import * as React from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import type { SortDir } from "@/components/ds";
import { cn } from "@/lib/utils";

export function SortHead({
  children,
  active,
  dir,
  onSort,
  align = "left",
  className,
  title,
  plain = false,
}: {
  children: React.ReactNode;
  active: boolean;
  dir: SortDir;
  onSort: () => void;
  align?: "left" | "right";
  className?: string;
  title?: string;
  /** Outside a role=table container: drop the columnheader role (the header is then just a sort button). */
  plain?: boolean;
}) {
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <span
      role={plain ? undefined : "columnheader"}
      aria-sort={plain ? undefined : active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("flex min-w-0", align === "right" && "justify-end", className)}
    >
      <button
        type="button"
        onClick={onSort}
        title={title}
        aria-pressed={plain ? active : undefined}
        className={cn(
          "-mx-1 inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active && "text-foreground",
          align === "right" && "flex-row-reverse",
        )}
      >
        <span className="truncate">{children}</span>
        <Icon className={cn("h-3 w-3 shrink-0", !active && "opacity-50")} aria-hidden="true" />
      </button>
    </span>
  );
}
