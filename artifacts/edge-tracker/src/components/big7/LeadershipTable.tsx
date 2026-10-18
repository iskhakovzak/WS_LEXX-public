/**
 * Leadership table: who leads and who lags QQQ right now, with gap, RVOL, VWAP, nearest levels,
 * correlation/beta and the contribution to QQQ. Sortable; a row opens the detail sheet.
 */
import { DataTable, Panel, SortableTh, TableSkeleton, useTableSort } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { Big7Row } from "./context";
import { LevelChip, RsBar, Signed, fmtRvol } from "./ui";
import { big7I18n } from "@/i18n/ns/big7";

type Key = "symbol" | "chg" | "rs" | "rs30" | "gap" | "rvol" | "vwap" | "corr" | "contrib";

const ACCESSORS: Record<Key, (r: Big7Row) => number | string | null> = {
  symbol: (r) => r.symbol,
  chg: (r) => r.chg,
  rs: (r) => r.rsQqq,
  rs30: (r) => r.rs30,
  gap: (r) => r.gap,
  rvol: (r) => r.rvol,
  vwap: (r) => r.vwapDist,
  corr: (r) => r.corr,
  contrib: (r) => r.contribQqq,
};

export function LeadershipTable({ rows, loading, onOpen, preOpen }: {
  rows: Big7Row[];
  loading: boolean;
  onOpen: (symbol: string) => void;
  /** Before the open the gap column shows the premarket move and VWAP is not meaningful. */
  preOpen: boolean;
}) {
  const { t } = big7I18n.useT();
  const { rows: sorted, thProps } = useTableSort(rows, ACCESSORS, "rs");
  return (
    <Panel
      title={t("leadership.title")}
      description={t("leadership.description")}
      bodyClassName="pt-1"
    >
      {loading && !rows.length ? (
        <TableSkeleton rows={7} cols={9} />
      ) : (
        <DataTable ariaLabel={t("leadership.aria")}>
          <table>
            <thead>
              <tr>
                <SortableTh {...thProps("symbol")}>{t("leadership.ticker")}</SortableTh>
                <SortableTh {...thProps("chg")} align="right">{t("leadership.chg")}</SortableTh>
                <SortableTh {...thProps("rs")} className="w-[180px]">{t("leadership.rs")}</SortableTh>
                <SortableTh {...thProps("rs30")} align="right">{t("leadership.rs30")}</SortableTh>
                <SortableTh {...thProps("gap")} align="right">{preOpen ? t("leadership.premarket") : t("leadership.gap")}</SortableTh>
                <SortableTh {...thProps("rvol")} align="right" term="rvol">RVOL</SortableTh>
                <SortableTh {...thProps("vwap")} align="right" term="vwap">{t("leadership.fromVwap")}</SortableTh>
                <th scope="col">{t("leadership.nearest")}</th>
                <SortableTh {...thProps("corr")} align="right">{t("leadership.corr")}</SortableTh>
                <SortableTh {...thProps("contrib")} align="right">{t("leadership.contrib")}</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.symbol}
                  tabIndex={0}
                  onClick={() => onOpen(r.symbol)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(r.symbol); } }}
                  className="cursor-pointer outline-none focus-visible:bg-[var(--tile-hover-bg)]"
                  aria-label={t("leadership.openRow", { symbol: r.symbol })}
                >
                  <td className="font-semibold">{r.symbol}</td>
                  <td className="text-right"><Signed value={r.chg} /></td>
                  <td>
                    <span className="flex items-center gap-2">
                      <RsBar value={r.rsQqq} className="flex-1" />
                      <Signed value={r.rsQqq} digits={2} suffix="" threshold={0.1} className="w-12 text-right text-xs" />
                    </span>
                  </td>
                  <td className="text-right text-xs"><Signed value={r.rs30} digits={2} suffix="" threshold={0.05} /></td>
                  <td className="text-right"><Signed value={preOpen ? r.pmChg ?? r.gap : r.gap} digits={2} threshold={0.05} /></td>
                  <td className={cn("text-right", r.rvol != null && r.rvol >= 1.5 ? "font-semibold text-primary" : "")}>{fmtRvol(r.rvol)}</td>
                  <td className="text-right">{preOpen ? <span className="text-muted-foreground">—</span> : <Signed value={r.vwapDist} digits={2} />}</td>
                  <td>
                    <span className="flex flex-col gap-0.5 text-xs">
                      <LevelChip level={r.above} dir="up" />
                      <LevelChip level={r.below} dir="down" />
                    </span>
                  </td>
                  <td className="text-right text-xs tabular-nums text-muted-foreground" title={t("leadership.corrTitle")}>
                    {r.corr != null ? (
                      <><span className="text-foreground">{r.corr.toFixed(2)}</span> / {r.beta != null ? r.beta.toFixed(2) : "—"}</>
                    ) : "—"}
                  </td>
                  <td className="text-right" title={r.wQqq != null ? t("leadership.weightTitle", { value: r.wQqq }) : t("leadership.noWeight")}>
                    <Signed value={r.contribQqq} digits={2} suffix="" threshold={0.005} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}
    </Panel>
  );
}
