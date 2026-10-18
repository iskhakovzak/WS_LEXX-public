import * as React from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PAGE_SIZES } from "./trade-utils";
import { tradesI18n } from "@/i18n/ns/trades";
import { commonI18n } from "@/i18n/ns/common";

type Props = {
  page: number;
  pageSize: number;
  total: number;
  returned: number;
  hasMore: boolean;
  fetching?: boolean;
  onPage: (n: number) => void;
  onPageSize: (n: number) => void;
  className?: string;
};

/** Footer of the paginated table: range · page jump · size selector. Keyboard: the inputs are plain controls. */
export function TradePagination(p: Props) {
  const { t } = tradesI18n.useT();
  const totalPages = Math.max(1, Math.ceil(p.total / p.pageSize));
  const from = p.total === 0 ? 0 : (p.page - 1) * p.pageSize + 1;
  const to = p.total === 0 ? 0 : Math.min(p.total, (p.page - 1) * p.pageSize + p.returned);
  const [draft, setDraft] = React.useState(String(p.page));
  React.useEffect(() => { setDraft(String(p.page)); }, [p.page]);

  function commit() {
    const n = Number(draft);
    if (Number.isInteger(n) && n >= 1 && n <= totalPages && n !== p.page) p.onPage(n);
    else setDraft(String(p.page));
  }

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground", p.className)} role="navigation" aria-label={t("pagination.nav")}>
      <div className="flex items-center gap-2 tabular-nums">
        {p.fetching && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label={commonI18n.t("states.loading")} />}
        <span>
          {p.total === 0 ? t("pagination.noRows") : t("pagination.range", { from, to, count: p.total })}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("pagination.first")} disabled={p.page <= 1} onClick={() => p.onPage(1)}>
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("pagination.prev")} disabled={p.page <= 1} onClick={() => p.onPage(p.page - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <form className="flex items-center gap-1 tabular-nums" onSubmit={(e) => { e.preventDefault(); commit(); }}>
          <span className="hidden sm:inline">{t("pagination.pageShort")}</span>
          <input
            aria-label={t("pagination.pageNumber")}
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
            onBlur={commit}
            className="glass-field h-8 w-12 rounded-full bg-transparent px-2 text-center text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span>{t("pagination.ofPages", { total: totalPages })}</span>
        </form>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("pagination.next")} disabled={!p.hasMore && p.page >= totalPages} onClick={() => p.onPage(p.page + 1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Select value={String(p.pageSize)} onValueChange={(v) => p.onPageSize(Number(v))}>
          <SelectTrigger aria-label={t("pagination.pageSize")} className="h-8 w-auto min-w-[112px] gap-1.5"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{t("pagination.perPage", { count: n })}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
