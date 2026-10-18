import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import { MARKET_BIAS, dateObj, gpApi, gpKeys, type GamePlanSummary } from "./types";
import { fmtDate } from "@/lib/format";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

function matches(p: GamePlanSummary, q: string) {
  if (!q) return true;
  const hay = `${p.date} ${p.author} ${personName(p.author)} ${p.marketView} ${p.tickers.join(" ")} ${fmtDate(dateObj(p.date), "dayMonthLong")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

export function HistoryPanel({
  current,
  onPick,
  searchRef,
}: {
  current: string;
  onPick: (date: string) => void;
  searchRef?: React.Ref<HTMLInputElement>;
}) {
  const { t } = gpI18n.useT();
  const [q, setQ] = useState("");
  const hq = useQuery({ queryKey: gpKeys.history, queryFn: () => gpApi.history(120), staleTime: 60_000 });
  const list = useMemo(() => (hq.data ?? []).filter((p) => matches(p, q.trim())), [hq.data, q]);

  return (
    <Panel title={t("history.title")} icon={History} description={hq.data ? t("history.published", { count: hq.data.length }) : undefined}>
      <label className="relative block">
        <span className="sr-only">{t("history.searchAria")}</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("history.searchPlaceholder")}
          className="pl-9"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQ("");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      <div className="mt-3 max-h-[min(70dvh,720px)] overflow-y-auto pr-1">
        {hq.isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : hq.isError ? (
          <p className="py-4 text-sm text-muted-foreground">{t("history.unavailable")}</p>
        ) : list.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{q ? commonI18n.t("states.nothingFound") : t("history.none")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {list.map((p) => {
              const b = MARKET_BIAS[p.bias] ?? MARKET_BIAS.neutral;
              const active = p.date === current;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onPick(p.date)}
                    aria-current={active ? "date" : undefined}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "bg-primary/12 ring-1 ring-primary/30" : "hover:bg-[var(--glass-hover-bg)]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium capitalize">
                        {fmtDate(dateObj(p.date), "weekdayDayMonth")}
                      </span>
                      <Pill tone={b.tone} dot>
                        {b.label}
                      </Pill>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{p.tickers.length ? p.tickers.slice(0, 6).join(" · ") : t("history.noTickers")}</span>
                      <span className="shrink-0 tabular-nums" title={t("history.readTitle")}>
                        {t("history.readShort", { count: p.readCount })}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
