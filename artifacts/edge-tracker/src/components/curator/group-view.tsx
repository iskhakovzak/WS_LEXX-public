/**
 * «Группа» / «Группы» in the curator cabinet (replaces the old «Мои трейдеры» grid).
 *
 *   Curator: «Моя группа» — traders whose users.assigned_curator is me: search (RU / EN / UZ, wrong layout, typos),
 *            filters (tier, active / no trades N days, at risk now, violations this week, pending reviews), sortable
 *            table with today / week / month, violations, reviews, last activity, academy stage, quick actions, CSV.
 *   Admin:   «Все группы» — every curator's group as a collapsible section with totals, plus «Без куратора»; search
 *            highlights matches and opens their groups; reassign a trader to another curator (confirm + undo).
 *   Deep link: /curator?view=traders&group=<curator name | none | all>.
 *   Cards view keeps the old card grid; its behaviour patterns come from ONE batch request (useTopPatterns).
 */
import * as React from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, BookText, CandlestickChart, ChevronDown, ChevronRight, ClipboardList, Download, LayoutGrid, MessagesSquare,
  MoreHorizontal, NotebookPen, Rows3, ShieldAlert, UserRound, UserRoundCog, Users, UsersRound,
} from "lucide-react";
import {
  DataTable, EmptyState, FilterChip, Pill, Segmented, SortableTh, Toolbar, toneText, usePersistentState, useTableSort,
} from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UndoToast } from "@/components/undo-toast";
import { downloadCsv } from "@/components/admin/api";
import { PeopleSearchInput } from "@/components/people/people-search-input";
import { PersonSelect } from "@/components/people/person-select";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { addDays } from "@/lib/trading-date";
import { cn } from "@/lib/utils";
import { curatorKeys, reassignCurator, useTopPatterns, type TraderSignal } from "./api";
import { riskTone, sortTraders, type TraderSort } from "./curator-math";
import {
  ALL_GROUPS, csvHead, DEFAULT_FILTERS, GROUP_SORT, NO_CURATOR, activeFilterCount, applyFilters, breachesWeek, buildGroups, csvRow,
  daysSinceTrade, groupTotals, isIdle, isRiskNow, pendingReviews, searchTraders, tradersOf,
  type GroupFilters, type GroupKey, type GroupTotals, type SearchMark,
} from "./group-model";
import { TraderCard } from "./trader-card";
import { CuratorNameHL, LatinHintHL, TraderNameHL } from "./name-highlight";
import { fmtDate, fmtUsd } from "@/lib/format";
import { comparePersonNames, personName } from "@/i18n";
import { curatorI18n } from "@/i18n/ns/curator";
import { commonI18n } from "@/i18n/ns/common";

// ── copy: read from the `curator` namespace at render time (getters follow the current language) ──────────
const t = curatorI18n.t;
const T = {
  get allGroups() { return t("group.allGroups"); },
  get myGroup() { return t("group.myGroup"); },
  get myGroupBadge() { return t("group.myGroupBadge"); },
  get mineSuffix() { return t("group.mineSuffix"); },
  get noCurator() { return t("group.noCurator"); },
  groupOf: (c: string) => t("group.groupOf", { name: c }),
  myGroupNamed: (c: string) => t("group.myGroupNamed", { name: personName(c) }),
  get groupPicker() { return t("group.groupPicker"); },
  get risk() { return t("group.risk"); },
  get violations() { return t("group.violations"); },
  get pending() { return t("group.pending"); },
  activity: {
    get all() { return t("group.activity.all"); },
    get active() { return t("group.activity.active"); },
    get idle() { return t("group.activity.idle"); },
  },
  idleDays: (n: number) => t("group.idleDays", { count: n }),
  get idleTitle() { return t("group.idleTitle"); },
  get tierAny() { return t("group.tierAny"); },
  get reset() { return commonI18n.t("actions.resetFilters"); },
  get table() { return t("group.table"); },
  get cards() { return t("group.cards"); },
  get patternsOn() { return t("group.patternsOn"); },
  get patternsOff() { return t("group.patternsOff"); },
  csv: "CSV",
  get csvTitle() { return t("group.csvTitle"); },
  cols: {
    get trader() { return t("group.cols.trader"); },
    get curator() { return t("group.cols.curator"); },
    get tier() { return t("group.cols.tier"); },
    get stage() { return t("group.cols.stage"); },
    get today() { return t("group.cols.today"); },
    get week() { return t("group.cols.week"); },
    get month() { return t("group.cols.month"); },
    get violations() { return t("group.cols.violations"); },
    get pending() { return t("group.cols.pending"); },
    get activity() { return t("group.cols.activity"); },
    get risk() { return t("group.cols.risk"); },
    get actions() { return t("group.cols.actions"); },
  },
  colHints: {
    get tier() { return t("group.colHints.tier"); },
    get violations() { return t("group.colHints.violations"); },
    get pending() { return t("group.colHints.pending"); },
    get activity() { return t("group.colHints.activity"); },
    get month() { return t("group.colHints.month"); },
  },
  get openGroup() { return t("group.openGroup"); },
  get collapseAll() { return t("group.collapseAll"); },
  get expandAll() { return t("group.expandAll"); },
  get emptyGroup() { return t("group.emptyGroup"); },
  get emptyCurators() { return t("group.emptyCurators"); },
  get nothing() { return t("group.nothing"); },
  get nothingHint() { return t("group.nothingHint"); },
  get noTraders() { return t("group.noTraders"); },
  get noTradersHint() { return t("group.noTradersHint"); },
  actions: {
    menu: (n: string) => t("group.actions.menu", { name: personName(n) }),
    withName: (action: string, n: string) => t("group.actions.withName", { action, name: personName(n) }),
    get profile() { return t("profileLink"); },
    get journal() { return t("group.actions.journal"); },
    get day() { return t("group.actions.day"); },
    get trades() { return t("group.actions.trades"); },
    get notes() { return t("group.actions.notes"); },
    get discussions() { return t("group.actions.discussions"); },
    get move() { return t("group.actions.move"); },
    moveTitle: (who: string, to: string | null) => (to ? t("group.actions.moveTitleTo", { name: personName(who), to: personName(to) }) : t("group.actions.moveTitleOut", { name: personName(who) })),
    moveDesc: (from: string | null) => (from ? t("group.actions.moveDescFrom", { from: personName(from) }) : t("group.actions.moveDescNone")),
    get reason() { return t("group.actions.reason"); },
    get reasonDefault() { return t("group.actions.reasonDefault"); },
    get confirm() { return t("group.actions.confirm"); },
    get moving() { return t("group.actions.moving"); },
    moved: (who: string) => personName(who),
    movedText: (to: string | null) => (to ? t("group.actions.movedTo", { to: personName(to) }) : t("group.actions.movedOut")),
    get undoReason() { return t("group.actions.undoReason"); },
    get failed() { return t("group.actions.failed"); },
    get noAccount() { return t("group.actions.noAccount"); },
  },
  get never() { return t("never"); },
  daysAgo: (n: number) => (n === 0 ? commonI18n.t("time.today").toLowerCase() : n === 1 ? commonI18n.t("time.yesterday").toLowerCase() : t("group.daysAgo", { count: n })),
  get noLimits() { return t("noLimits"); },
  stageNone: "—",
  get stagePrefix() { return t("group.stagePrefix"); },
  shown: (a: number, b: number) => t("group.shown", { shown: a, total: b }),
};

const CARD_SORT_KEYS: readonly TraderSort[] = ["attention", "pnl", "discipline", "name"];
const cardSorts = () => CARD_SORT_KEYS.map((value) => ({ value, label: t(`group.cardSort.${value}`) }));
const IDLE_OPTIONS = [3, 5, 10, 20] as const;

type Props = {
  traders: TraderSignal[];
  /** Trading day of the payload (NY). */
  date: string;
  group: GroupKey | null;
  onGroupChange: (g: GroupKey) => void;
  onOpenTrader: (trader: string, tab?: string) => void;
};

export function GroupView({ traders, date, group: groupParam, onGroupChange, onOpenTrader }: Props) {
  const { user, isAdmin, can, dbUsers } = useAuth();
  const me = user?.traderName ?? null;
  const canMove = can("users.manage");
  const qc = useQueryClient();
  const { toast } = useToast();

  const myCount = React.useMemo(() => traders.filter((s) => s.curator === me).length, [traders, me]);
  const curators = React.useMemo(
    () => dbUsers.filter((u) => u.active && !u.banned && (u.role === "curator" || u.role === "admin")).map((u) => u.name).sort(comparePersonNames),
    [dbUsers],
  );
  const groupCounts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const s of traders) { const k = s.curator ?? NO_CURATOR; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [traders]);

  const defaultGroup: GroupKey = me && myCount > 0 ? me : ALL_GROUPS;
  const group: GroupKey = groupParam && (groupParam === ALL_GROUPS || groupParam === NO_CURATOR || groupCounts.has(groupParam) || curators.includes(groupParam)) ? groupParam : defaultGroup;

  const [q, setQ] = React.useState("");
  const deferredQ = React.useDeferredValue(q);
  const [filters, setFilters] = usePersistentState<GroupFilters>("curator.group.filters", DEFAULT_FILTERS);
  const f: GroupFilters = { ...DEFAULT_FILTERS, ...filters };
  const patch = (p: Partial<GroupFilters>) => setFilters({ ...f, ...p });
  const [mode, setMode] = usePersistentState<"table" | "cards">("curator.group.mode", "table");
  const [cardSort, setCardSort] = usePersistentState<TraderSort>("curator.sort", "attention");
  const [patterns, setPatterns] = usePersistentState<"on" | "off">("curator.patterns", "on");

  const inGroup = React.useMemo(() => tradersOf(traders, group), [traders, group]);
  const searched = React.useMemo(() => searchTraders(inGroup, deferredQ), [inGroup, deferredQ]);
  const shown = React.useMemo(() => applyFilters(searched.list, f, date), [searched, f.risk, f.violations, f.pending, f.activity, f.idleDays, f.tier, date]); // eslint-disable-line react-hooks/exhaustive-deps
  const narrowed = !!deferredQ.trim() || activeFilterCount(f) > 0;

  const counts = React.useMemo(() => ({
    risk: searched.list.filter(isRiskNow).length,
    violations: searched.list.filter((s) => breachesWeek(s) > 0).length,
    pending: searched.list.filter((s) => pendingReviews(s) > 0).length,
    idle: searched.list.filter((s) => isIdle(s, date, f.idleDays)).length,
  }), [searched, date, f.idleDays]);
  const tiers = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const s of traders) if (s.tier) m.set(s.tier, s.tierName ?? s.tier);
    return [...m.entries()];
  }, [traders]);

  // ── reassign (confirm → undo) ──
  const [move, setMove] = React.useState<{ s: TraderSignal; to: string | null } | null>(null);
  const [reason, setReason] = React.useState<string>(T.actions.reasonDefault);
  const [busy, setBusy] = React.useState(false);
  const [undo, setUndo] = React.useState<{ key: number; trader: string; userId: number; from: string | null; to: string | null } | null>(null);
  const userIdOf = (name: string) => dbUsers.find((u) => u.name === name)?.id ?? null;
  const askMove = (s: TraderSignal, to: string | null) => { setReason(T.actions.reasonDefault); setMove({ s, to }); };
  const doMove = async () => {
    if (!move) return;
    const id = userIdOf(move.s.trader);
    if (id == null) { toast({ title: T.actions.failed, description: T.actions.noAccount, variant: "destructive" }); return; }
    setBusy(true);
    try {
      await reassignCurator(id, move.to, reason.trim() || T.actions.reasonDefault);
      setUndo({ key: Date.now(), trader: move.s.trader, userId: id, from: move.s.curator ?? null, to: move.to });
      setMove(null);
      void qc.invalidateQueries({ queryKey: curatorKeys.all });
      void qc.invalidateQueries({ queryKey: ["admin-console"] });
      void qc.invalidateQueries({ queryKey: ["people-directory"] });
    } catch (e) {
      toast({ title: T.actions.failed, description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const undoMove = async () => {
    if (!undo) return;
    try {
      await reassignCurator(undo.userId, undo.from, T.actions.undoReason);
      void qc.invalidateQueries({ queryKey: curatorKeys.all });
    } catch (e) {
      toast({ title: T.actions.failed, description: (e as Error).message, variant: "destructive" });
    } finally {
      setUndo(null);
    }
  };

  // ── cards: one batch request for patterns ──
  const to = date;
  const from = addDays(to, -28);
  const topPatterns = useTopPatterns(shown.map((s) => s.trader), from, to, mode === "cards" && patterns === "on");

  const exportCsv = () => downloadCsv(csvHead(), shown.map(csvRow), `group-${group === ALL_GROUPS ? "all" : group === NO_CURATOR ? "none" : group}-${date}.csv`);

  const groupLabel = (k: GroupKey) => (k === ALL_GROUPS ? T.allGroups : k === NO_CURATOR ? T.noCurator : k === me ? T.myGroupNamed(k) : personName(k));
  const groupOptions = [
    ...[...new Set([...curators, ...[...groupCounts.keys()].filter((k) => k !== NO_CURATOR)])]
      .sort((a, b) => (a === me ? -1 : b === me ? 1 : comparePersonNames(a, b)))
      .map((c) => ({ value: c, label: personName(c), hint: String(groupCounts.get(c) ?? 0) })),
    { value: NO_CURATOR, label: T.noCurator, hint: String(groupCounts.get(NO_CURATOR) ?? 0) },
  ];

  const rowProps: RowCommon = { date, marks: searched.marks, onOpenTrader, canMove, curators, onMove: askMove };

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <Toolbar>
        <PersonSelect
          value={group}
          onValueChange={(v) => onGroupChange(v || ALL_GROUPS)}
          allValue={ALL_GROUPS}
          allLabel={`${T.allGroups} · ${traders.length}`}
          options={groupOptions}
          placeholder={T.groupPicker}
          ariaLabel={T.groupPicker}
          self={me}
          selfSuffix={T.mineSuffix}
          icon={UsersRound}
          className="w-56"
        />
        {me && myCount > 0 && group !== me && (
          <FilterChip active={false} onClick={() => onGroupChange(me)} count={myCount}>{T.myGroup}</FilterChip>
        )}
        <PeopleSearchInput value={q} onChange={setQ} className="sm:w-60" />
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          {mode === "cards" && (
            <>
              <Segmented size="sm" ariaLabel={t("group.patternsAria")} value={patterns} onChange={setPatterns} options={[{ value: "on", label: T.patternsOn }, { value: "off", label: T.patternsOff }]} />
              <Segmented size="sm" ariaLabel={t("group.cardSortAria")} value={cardSort} onChange={setCardSort} options={cardSorts()} />
            </>
          )}
          <Segmented
            size="sm"
            ariaLabel={t("group.viewAria")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "table", label: <span className="inline-flex items-center gap-1.5"><Rows3 aria-hidden="true" />{T.table}</span> },
              { value: "cards", label: <span className="inline-flex items-center gap-1.5"><LayoutGrid aria-hidden="true" />{T.cards}</span> },
            ]}
          />
          <Button type="button" variant="outline" size="sm" onClick={exportCsv} disabled={!shown.length} title={T.csvTitle}><Download /> {T.csv}</Button>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5" role="group" aria-label={t("group.filtersAria")}>
          <FilterChip size="sm" active={f.risk} onClick={() => patch({ risk: !f.risk })} count={counts.risk}><ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />{T.risk}</FilterChip>
          <FilterChip size="sm" active={f.violations} onClick={() => patch({ violations: !f.violations })} count={counts.violations}><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />{T.violations}</FilterChip>
          <FilterChip size="sm" active={f.pending} onClick={() => patch({ pending: !f.pending })} count={counts.pending}><ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />{T.pending}</FilterChip>
          <Segmented
            size="sm"
            ariaLabel={t("group.activityAria")}
            value={f.activity}
            onChange={(v) => patch({ activity: v })}
            options={[
              { value: "all", label: T.activity.all },
              { value: "active", label: T.activity.active },
              { value: "idle", label: T.activity.idle, count: counts.idle },
            ]}
          />
          <Select value={String(f.idleDays)} onValueChange={(v) => patch({ idleDays: Number(v) })}>
            <SelectTrigger className="h-8 w-[5.5rem] px-3 text-xs" aria-label={T.idleTitle} title={T.idleTitle}><SelectValue /></SelectTrigger>
            <SelectContent>{IDLE_OPTIONS.map((n) => <SelectItem key={n} value={String(n)}>{T.idleDays(n)}</SelectItem>)}</SelectContent>
          </Select>
          {tiers.length > 0 && (
            <Select value={f.tier || "__any"} onValueChange={(v) => patch({ tier: v === "__any" ? "" : v })}>
              <SelectTrigger className="h-8 w-36 px-3 text-xs" aria-label={t("group.tierAria")}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">{T.tierAny}</SelectItem>
                {tiers.map(([k, n]) => <SelectItem key={k} value={k}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {activeFilterCount(f) > 0 && <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setFilters(DEFAULT_FILTERS)}>{T.reset}</Button>}
          {narrowed && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{T.shown(shown.length, inGroup.length)}</span>}
        </div>
      </Toolbar>

      {traders.length === 0 ? (
        <EmptyState icon={Users} title={T.noTraders} description={T.noTradersHint} />
      ) : group === ALL_GROUPS && mode === "table" ? (
        <AllGroups
          traders={shown}
          allTraders={inGroup}
          curators={curators}
          me={me}
          narrowed={narrowed}
          search={deferredQ}
          idleDays={f.idleDays}
          onOpenGroup={onGroupChange}
          row={rowProps}
          showEmptyCurators={isAdmin && !narrowed}
        />
      ) : (
        <>
          <TotalsStrip totals={groupTotals(shown, date, f.idleDays)} idleDays={f.idleDays} title={narrowed ? `${groupLabel(group)} · ${T.shown(shown.length, inGroup.length)}` : groupLabel(group)} />
          {shown.length === 0 ? (
            <EmptyState
              icon={Users}
              title={inGroup.length ? T.nothing : T.emptyGroup}
              description={inGroup.length ? T.nothingHint : undefined}
              action={narrowed ? <Button variant="outline" size="sm" onClick={() => { setQ(""); setFilters(DEFAULT_FILTERS); }}>{T.reset}</Button> : undefined}
            />
          ) : mode === "table" ? (
            <GroupTable rows={shown} showCurator={group === ALL_GROUPS} row={rowProps} />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-[var(--grid-gap)]">
              {sortTraders(shown, cardSort).map((s) => (
                <TraderCard
                  key={s.trader}
                  s={s}
                  title={<TraderNameHL s={s} mark={searched.marks.get(s.trader)} />}
                  showPatterns={patterns === "on"}
                  patterns={topPatterns.data?.[s.trader] ?? null}
                  patternsLoading={topPatterns.isLoading}
                  onOpen={(tab) => onOpenTrader(s.trader, tab)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <AlertDialog open={!!move} onOpenChange={(v) => { if (!v && !busy) setMove(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{move ? T.actions.moveTitle(move.s.trader, move.to) : ""}</AlertDialogTitle>
            <AlertDialogDescription>{move ? T.actions.moveDesc(move.s.curator ?? null) : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="move-reason" className="text-xs text-muted-foreground">{T.actions.reason}</Label>
            <Input id="move-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{commonI18n.t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={busy || reason.trim().length < 3} onClick={(e) => { e.preventDefault(); void doMove(); }}>
              {busy ? T.actions.moving : T.actions.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {undo && (
        <UndoToast
          key={undo.key}
          label={T.actions.moved(undo.trader)}
          actionText={T.actions.movedText(undo.to)}
          durationMs={15_000}
          onUndo={() => void undoMove()}
          onDismiss={() => setUndo(null)}
        />
      )}
    </div>
  );
}

// ── totals ──────────────────────────────────────────────────────────────────

function money(v: number | null) {
  return <span className={cn("tabular-nums", v == null ? "text-muted-foreground" : v > 0 ? "text-up" : v < 0 ? "text-down" : "text-foreground")}>{fmtUsd(v, { signed: true, decimals: 0 })}</span>;
}

function TotalsInline({ t: x, idleDays }: { t: GroupTotals; idleDays: number }) {
  const { t: tr } = curatorI18n.useT();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular-nums text-foreground">{tr("group.totals.traders", { count: x.traders })}</span>
      <span>{tr("group.totals.today")} {money(x.today)}</span>
      <span>{tr("group.totals.week")} {money(x.week)}</span>
      <span>{tr("group.totals.month")} {money(x.month)}</span>
      {x.violations > 0 && <span className="tabular-nums text-down" title={T.colHints.violations}>{tr("group.totals.violations", { count: x.violations })}</span>}
      {x.pending > 0 && <span className="tabular-nums text-primary" title={T.colHints.pending}>{tr("group.totals.pending", { count: x.pending })}</span>}
      {x.atRisk > 0 && <span className="tabular-nums text-warn">{tr("group.totals.atRisk", { count: x.atRisk })}</span>}
      {x.idle > 0 && <span className="tabular-nums" title={T.idleTitle}>{tr("group.totals.idle", { count: x.idle, days: T.idleDays(idleDays) })}</span>}
    </span>
  );
}

function TotalsStrip({ totals, idleDays, title }: { totals: GroupTotals; idleDays: number; title: string }) {
  return (
    <div className="glass-panel flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl px-[var(--panel-p)] py-2.5">
      <span className="flex items-center gap-2 text-sm font-semibold text-foreground"><UsersRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{title}</span>
      <TotalsInline t={totals} idleDays={idleDays} />
    </div>
  );
}

// ── all groups (sections) ───────────────────────────────────────────────────

function AllGroups({
  traders, allTraders, curators, me, narrowed, search, idleDays, onOpenGroup, row, showEmptyCurators,
}: {
  traders: TraderSignal[]; allTraders: TraderSignal[]; curators: string[]; me: string | null; narrowed: boolean; search: string; idleDays: number;
  onOpenGroup: (g: GroupKey) => void; row: RowCommon; showEmptyCurators: boolean;
}) {
  const groups = React.useMemo(() => buildGroups(traders, showEmptyCurators ? curators : [], me), [traders, curators, me, showEmptyCurators]);
  const sizes = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const s of allTraders) { const k = s.curator ?? NO_CURATOR; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [allTraders]);
  const [collapsed, setCollapsed] = usePersistentState<string[]>("curator.group.collapsed", []);
  const closed = new Set(collapsed);
  // Search / filters open every group with matches and hide the empty ones.
  const visible = groups.filter((g) => g.traders.length > 0);
  // Curators without traders: one quiet line at the bottom instead of empty sections on top.
  const emptyCurators = narrowed ? [] : groups.filter((g) => g.curator && !g.traders.length).map((g) => g.curator!);
  const isOpen = (k: string) => narrowed || !closed.has(k);
  const toggle = (k: string) => setCollapsed(closed.has(k) ? collapsed.filter((x) => x !== k) : [...collapsed, k]);
  const anyOpen = visible.some((g) => isOpen(g.key));

  if (!visible.length && !emptyCurators.length) return <EmptyState icon={Users} title={T.nothing} description={T.nothingHint} />;
  return (
    <div className="flex flex-col gap-3">
      {!narrowed && visible.length > 1 && (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => setCollapsed(anyOpen ? visible.map((g) => g.key) : [])}>
            {anyOpen ? T.collapseAll : T.expandAll}
          </Button>
        </div>
      )}
      {visible.map((g) => {
        const open = isOpen(g.key);
        const totals = groupTotals(g.traders, row.date, idleDays);
        const label = g.curator ? personName(g.curator) : T.noCurator;
        return (
          <section key={g.key} className="glass-panel min-w-0 overflow-hidden rounded-2xl" aria-label={T.groupOf(label)}>
            <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-[var(--panel-p)] py-2.5">
              <button
                type="button"
                onClick={() => toggle(g.key)}
                disabled={narrowed}
                aria-expanded={open}
                className="flex min-w-0 items-center gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <span className={cn("truncate text-sm font-semibold", g.curator ? "text-foreground" : "text-warn")} title={label}>{label}</span>
                {g.curator === me && <Pill tone="accent">{T.myGroupBadge}</Pill>}
                {narrowed && <span className="text-xs tabular-nums text-muted-foreground">{T.shown(g.traders.length, sizes.get(g.key) ?? 0)}</span>}
              </button>
              <span className="min-w-0 flex-1"><TotalsInline t={totals} idleDays={idleDays} /></span>
              <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => onOpenGroup(g.key)}>{T.openGroup}</Button>
            </header>
            {open && (g.traders.length
              ? <div className="border-t border-[var(--glass-border)]"><GroupTable rows={g.traders} showCurator={false} row={row} compact /></div>
              : <p className="border-t border-[var(--glass-border)] px-[var(--panel-p)] py-3 text-xs text-muted-foreground">{T.emptyGroup}{search ? "" : "."}</p>)}
          </section>
        );
      })}
      {emptyCurators.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          {T.emptyCurators}{" "}
          {emptyCurators.map((c, i) => (
            <React.Fragment key={c}>
              {i > 0 && ", "}
              <button type="button" className="rounded text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenGroup(c)}>{personName(c)}</button>
            </React.Fragment>
          ))}
        </p>
      )}
    </div>
  );
}

// ── table ───────────────────────────────────────────────────────────────────

type RowCommon = {
  date: string;
  marks: Map<string, SearchMark>;
  onOpenTrader: (trader: string, tab?: string) => void;
  canMove: boolean;
  curators: string[];
  onMove: (s: TraderSignal, to: string | null) => void;
};

function GroupTable({ rows, showCurator, row, compact = false }: { rows: TraderSignal[]; showCurator: boolean; row: RowCommon; compact?: boolean }) {
  const { rows: sorted, thProps } = useTableSort(rows, GROUP_SORT, "attention", "desc", {
    trader: "asc", curator: "asc", tier: "asc", stage: "asc", today: "asc", week: "asc", month: "asc",
  });
  return (
    <DataTable maxHeight={compact ? undefined : "68vh"} stickyFirstCol ariaLabel={t("group.tableAria")} className={cn(compact && "rounded-none border-0")}>
      <table>
        <thead>
          <tr>
            <SortableTh {...thProps("trader")}>{T.cols.trader}</SortableTh>
            {showCurator && <SortableTh {...thProps("curator")}>{T.cols.curator}</SortableTh>}
            <SortableTh {...thProps("tier")}><span title={T.colHints.tier}>{T.cols.tier}</span></SortableTh>
            <SortableTh {...thProps("today")} align="right">{T.cols.today}</SortableTh>
            <SortableTh {...thProps("week")} align="right">{T.cols.week}</SortableTh>
            <SortableTh {...thProps("month")} align="right"><span title={T.colHints.month}>{T.cols.month}</span></SortableTh>
            <SortableTh {...thProps("violations")} align="right"><span title={T.colHints.violations}>{T.cols.violations}</span></SortableTh>
            <SortableTh {...thProps("pending")} align="right"><span title={T.colHints.pending}>{T.cols.pending}</span></SortableTh>
            <SortableTh {...thProps("activity")} align="right"><span title={T.colHints.activity}>{T.cols.activity}</span></SortableTh>
            <SortableTh {...thProps("risk")}>{T.cols.risk}</SortableTh>
            <th scope="col" className="w-24"><span className="sr-only">{T.cols.actions}</span></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => <GroupRow key={s.trader} s={s} showCurator={showCurator} row={row} />)}
        </tbody>
      </table>
    </DataTable>
  );
}

const GroupRow = React.memo(function GroupRow({ s, showCurator, row }: { s: TraderSignal; showCurator: boolean; row: RowCommon }) {
  const mark = row.marks.get(s.trader);
  const days = daysSinceTrade(s, row.date);
  const lastAct = s.lastActivityAt ? s.lastActivityAt.slice(0, 10) : s.lastTradeDate;
  const actDays = lastAct ? Math.max(0, Math.round((Date.parse(`${row.date}T12:00:00Z`) - Date.parse(`${lastAct}T12:00:00Z`)) / 86_400_000)) : null;
  const pend = pendingReviews(s);
  const wk = breachesWeek(s);
  const enc = encodeURIComponent(s.trader);
  return (
    <tr className={cn(s.risk.halted && "bg-down/5")}>
      <td className="max-w-[16rem]">
        <button type="button" onClick={() => row.onOpenTrader(s.trader)} className="block min-w-0 max-w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={T.actions.withName(T.actions.profile, s.trader)}>
          <span className="block truncate font-medium text-foreground hover:text-primary">
            <TraderNameHL s={s} mark={mark} />
          </span>
          <LatinHintHL s={s} mark={mark} />
        </button>
      </td>
      {showCurator && (
        <td className="whitespace-nowrap">
          {s.curator ? <CuratorNameHL name={s.curator} mark={mark} /> : <span className="text-warn">{T.noCurator}</span>}
        </td>
      )}
      <td className="whitespace-nowrap">
        {s.tierName ?? <span className="text-muted-foreground">—</span>}
        {s.stage.label && s.stage.label !== s.tierName && <div className="text-2xs text-muted-foreground" title={T.cols.stage}>{T.stagePrefix} {s.stage.label}</div>}
      </td>
      <td className="whitespace-nowrap text-right" title={`${t("tradesShort", { count: s.risk.todayTrades })}${s.risk.openPositions ? ` · ${t("openShort", { count: s.risk.openPositions })}` : ""}`}>
        {s.risk.todayTrades ? money(s.risk.todayPnl) : <span className="text-muted-foreground">—</span>}
        {s.risk.todayTrades > 0 && <div className="text-2xs tabular-nums text-muted-foreground">{t("tradesShort", { count: s.risk.todayTrades })}</div>}
      </td>
      <td className="whitespace-nowrap text-right">{money(s.risk.weekPnl)}</td>
      <td className="whitespace-nowrap text-right">
        {money(s.month?.pnl ?? null)}
        {s.month && s.month.trades > 0 && <div className="text-2xs tabular-nums text-muted-foreground">{t("tradesShort", { count: s.month.trades })}</div>}
      </td>
      <td className="whitespace-nowrap text-right tabular-nums">
        {wk ? <span className={toneText(wk > 1 ? "down" : "warn")}>{wk}</span> : <span className="text-muted-foreground">0</span>}
        {s.breaches.unreviewed > 0 && <div className="text-2xs text-down">{t("group.unreviewed", { count: s.breaches.unreviewed })}</div>}
      </td>
      <td className="whitespace-nowrap text-right tabular-nums">
        {pend ? <Link href={s.nextAction.kind === "eod_review" || s.nextAction.kind === "weekly_review" ? s.nextAction.href : `/curator?trader=${enc}&tab=journal`} className="text-primary hover:underline">{pend}</Link> : <span className="text-muted-foreground">0</span>}
      </td>
      <td className="whitespace-nowrap text-right text-xs" title={[s.lastActivityAt ? t("group.activityOn", { date: fmtDate(s.lastActivityAt.slice(0, 10), "dayMonth") }) : null, s.lastTradeDate ? t("group.lastTradeOn", { date: fmtDate(s.lastTradeDate, "dayMonth") }) : null].filter(Boolean).join(" · ") || undefined}>
        <span className={cn("tabular-nums", actDays == null ? "text-muted-foreground" : actDays >= 5 ? "text-warn" : "text-foreground")}>{actDays == null ? T.never : T.daysAgo(actDays)}</span>
        {days != null && days !== actDays && <div className="text-2xs tabular-nums text-muted-foreground">{t("group.tradeOn", { date: fmtDate(s.lastTradeDate, "dayMonth") })}</div>}
      </td>
      <td className="whitespace-nowrap">
        <span title={s.risk.message || undefined}><Pill tone={riskTone(s.risk.state)} dot>{s.risk.hasLimits ? s.risk.label : T.noLimits}</Pill></span>
      </td>
      <td className="whitespace-nowrap text-right">
        <span className="inline-flex items-center gap-0.5">
          <Button asChild variant="ghost" size="icon" className="h-8 w-8" title={T.actions.journal}>
            <Link href={`/journal?trader=${enc}`} aria-label={T.actions.withName(T.actions.journal, s.trader)}><BookText /></Link>
          </Button>
          <Button asChild variant="ghost" size="icon" className="h-8 w-8" title={T.actions.day}>
            <Link href={`/day-report?trader=${enc}`} aria-label={T.actions.withName(T.actions.day, s.trader)}><ClipboardList /></Link>
          </Button>
          <RowMenu s={s} row={row} />
        </span>
      </td>
    </tr>
  );
});

function RowMenu({ s, row }: { s: TraderSignal; row: RowCommon }) {
  const enc = encodeURIComponent(s.trader);
  const targets = row.curators.filter((c) => c !== s.curator && c !== s.trader);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={T.actions.menu(s.trader)}><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{personName(s.trader)}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => row.onOpenTrader(s.trader)}><UserRound /> {T.actions.profile}</DropdownMenuItem>
        <DropdownMenuItem asChild><Link href={`/journal?trader=${enc}`}><BookText /> {T.actions.journal}</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link href={`/day-report?trader=${enc}`}><ClipboardList /> {T.actions.day}</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link href={`/trades?trader=${enc}`}><CandlestickChart /> {T.actions.trades}</Link></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => row.onOpenTrader(s.trader, "notes")}><NotebookPen /> {T.actions.notes}</DropdownMenuItem>
        <DropdownMenuItem asChild><Link href={`/discussions?q=${enc}`}><MessagesSquare /> {T.actions.discussions}</Link></DropdownMenuItem>
        {row.canMove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><UserRoundCog /> {T.actions.move}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[min(60dvh,24rem)] overflow-y-auto">
                {targets.map((c) => <DropdownMenuItem key={c} onSelect={() => row.onMove(s, c)}>{personName(c)}</DropdownMenuItem>)}
                {s.curator && (
                  <>
                    {targets.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem onSelect={() => row.onMove(s, null)}>{T.noCurator}</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
