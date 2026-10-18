import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  Ban, BookOpen, CalendarCheck, Download, Flame, KeyRound, MoreHorizontal, Search, ShieldAlert, UserCheck, UserCog, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { QueryError } from "@/components/query-error";
import {
  DataTable, EmptyState, FilterChip, Kbd, Panel, Pill, ProgressRing, SortableTh, StatRow, useTableSort, type Tone,
} from "@/components/ds";
import { cn } from "@/lib/utils";
import { ActivityStrip } from "./ActivityStrip";
import { downloadCsv, isTypingTarget, roleLabel, timeAgo, type DeskPulse, type PulseUser } from "./api";
import { useUserActions } from "./useUserActions";
import { matchPerson, prepareQuery, usePeopleAliases } from "@/components/people/search";
import { fmtDate } from "@/lib/format";
import { adminI18n } from "@/i18n/ns/admin";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

export type TraderFilter = "all" | "traders" | "staff" | "nojournal" | "violations" | "stale" | "banned";

const FILTERS: readonly TraderFilter[] = ["all", "traders", "staff", "nojournal", "violations", "stale", "banned"];
/** Signal filters: shown only when they match someone (or are selected) — fewer chips at once. */
const SIGNAL_FILTERS = new Set<TraderFilter>(["nojournal", "violations", "stale", "banned"]);

const STALE_MS = 3 * 86_400_000;
const isStale = (u: PulseUser) => !u.lastSeen || Date.now() - Date.parse(u.lastSeen) > STALE_MS;

function matches(u: PulseUser, f: TraderFilter) {
  switch (f) {
    case "traders": return u.role === "trader";
    case "staff": return u.role !== "trader";
    case "nojournal": return u.role === "trader" && !u.banned && !u.journalToday;
    case "violations": return u.violationsWeek > 0;
    case "stale": return !u.banned && isStale(u);
    case "banned": return u.banned;
    default: return true;
  }
}

const ACCESSORS = {
  name: (u: PulseUser) => personName(u.name),
  lastSeen: (u: PulseUser) => (u.lastSeen ? Date.parse(u.lastSeen) : null),
  today: (u: PulseUser) => u.tradesToday,
  week: (u: PulseUser) => u.tradesWeek,
  streak: (u: PulseUser) => u.notesStreak,
  violations: (u: PulseUser) => u.violationsWeek * 1000 + u.violationsTotal,
};

const FILTER_KEY = "admin.traders.filter";

function roleTone(role: string): Tone {
  return role === "admin" ? "purple" : role === "curator" ? "accent" : "neutral";
}

export type RiskStatus = "breach" | "warn" | "ok" | "no_limits";

function RiskPill({ status }: { status: RiskStatus | undefined }) {
  const { t } = adminI18n.useT();
  if (!status) return <span className="text-muted-foreground">—</span>;
  if (status === "breach") return <Pill tone="down" dot>{t("activity.risk.breach")}</Pill>;
  if (status === "warn") return <Pill tone="warn" dot>{t("activity.risk.warn")}</Pill>;
  if (status === "ok") return <Pill tone="up">{t("activity.risk.ok")}</Pill>;
  return <Pill tone="neutral">{t("activity.risk.none")}</Pill>;
}

function StatusPill({ u }: { u: PulseUser }) {
  const { t } = adminI18n.useT();
  if (u.banned) return <Pill tone="down" dot>{t("activity.status.banned")}</Pill>;
  if (!u.active) return <Pill tone="neutral">{t("activity.status.inactive")}</Pill>;
  if (u.activeToday) return <Pill tone="up" dot>{t("activity.status.today")}</Pill>;
  if (isStale(u)) return <Pill tone="warn">{t("activity.status.stale")}</Pill>;
  return <Pill tone="neutral">{t("activity.status.notToday")}</Pill>;
}

function StreakCell({ u, journalAvailable }: { u: PulseUser; journalAvailable: boolean }) {
  const { t } = adminI18n.useT();
  if (!journalAvailable) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-flex items-center gap-1 font-semibold tabular-nums", u.notesStreak >= 3 ? "text-[hsl(var(--chart-3))]" : "text-foreground")}>
        {u.notesStreak >= 3 && <Flame className="h-3.5 w-3.5" aria-hidden="true" />}
        {u.notesStreak}
        <span className="sr-only">{t("activity.streakSr")}</span>
      </span>
      {u.journalToday
        ? <Pill tone="up" className="px-1.5">{t("activity.journalToday")}</Pill>
        : u.role === "trader" && !u.banned ? <Pill tone="warn" className="px-1.5">{t("activity.noEntry")}</Pill> : null}
    </span>
  );
}

function ViolationsCell({ u, available }: { u: PulseUser; available: boolean }) {
  const { t } = adminI18n.useT();
  if (!available) return <span className="text-muted-foreground">—</span>;
  if (u.violationsTotal === 0) return <span className="text-muted-foreground tabular-nums">0</span>;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 tabular-nums">
      {u.violationsWeek > 0
        ? <Pill tone={u.violationsHighWeek > 0 ? "down" : "warn"}>{t("activity.violationsWeek", { count: u.violationsWeek })}</Pill>
        : <span className="text-muted-foreground">{t("activity.violationsWeek", { count: 0 })}</span>}
      <span className="text-xs text-muted-foreground">/ {u.violationsTotal}</span>
    </span>
  );
}

export function TradersTable({
  actor,
  isAdmin,
  pulse,
  isLoading,
  error,
  onRetry,
  onChange,
  filter: filterProp,
  onFilterChange,
  riskStatus,
}: {
  /** trader → risk-desk status; undefined when /api/risk/desk is unavailable (column hidden). */
  riskStatus?: Map<string, RiskStatus>;
  actor: string;
  isAdmin: boolean;
  pulse: DeskPulse | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onChange: () => void;
  filter?: TraderFilter;
  onFilterChange?: (f: TraderFilter) => void;
}) {
  const [localFilter, setLocalFilter] = useState<TraderFilter>(() => {
    try { return (localStorage.getItem(FILTER_KEY) as TraderFilter) || "all"; } catch { return "all"; }
  });
  const filter = filterProp ?? localFilter;
  const setFilter = (f: TraderFilter) => {
    setLocalFilter(f);
    onFilterChange?.(f);
    try { localStorage.setItem(FILTER_KEY, f); } catch { /* ignore */ }
  };
  const { t } = adminI18n.useT();
  const [q, setQ] = useState("");
  const [openName, setOpenName] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const actions = useUserActions(actor, onChange);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !isTypingTarget(e.target) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const users = pulse?.users ?? [];
  const counts = useMemo(() => {
    const c = {} as Record<TraderFilter, number>;
    for (const f of FILTERS) c[f] = users.filter((u) => matches(u, f)).length;
    return c;
  }, [users]);
  const aliases = usePeopleAliases();
  const filtered = useMemo(() => {
    const pq = prepareQuery(q);
    return users.filter((u) => matches(u, filter) && (pq.empty || matchPerson(pq, u.name, aliases)));
  }, [users, filter, q, aliases]);
  const { rows, thProps } = useTableSort(filtered, ACCESSORS, "lastSeen");
  const open = openName ? users.find((u) => u.name === openName) ?? null : null;

  const exportCsv = () => {
    downloadCsv(
      (["name", "role", "status", "lastSeen", "today", "week", "lastTrade", "journalToday", "streak", "journal30", "violationsToday", "violationsWeek", "violationsTotal"] as const).map((k) => t(`activity.csv.${k}`)),
      rows.map((u) => [
        personName(u.name), roleLabel(u.role), u.banned ? t("activity.csv.banned") : u.active ? t("activity.csv.active") : t("activity.csv.inactive"),
        u.lastSeen ?? "", u.tradesToday, u.tradesWeek, u.lastTradeDate ?? "", commonI18n.t(u.journalToday ? "yes" : "no").toLowerCase(),
        u.notesStreak, u.journal30, u.violationsToday, u.violationsWeek, u.violationsTotal,
      ]),
      `desk-activity-${pulse?.date ?? "today"}.csv`,
    );
  };

  const menu = (u: PulseUser) => {
    const isSelf = u.name === actor;
    const canTouch = isAdmin || u.role !== "admin";
    const canBan = !isSelf && u.role !== "admin" && (isAdmin || u.role !== "curator");
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 data-[state=open]:opacity-100"
            aria-label={t("people.menu.aria", { name: personName(u.name) })}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuLabel className="text-xs text-muted-foreground">{personName(u.name)}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setOpenName(u.name)}><UserCog /> {t("activity.menu.card")}</DropdownMenuItem>
          {canTouch && <DropdownMenuItem onSelect={() => actions.setPassword(u)}><KeyRound /> {t("activity.menu.password")}</DropdownMenuItem>}
          {canTouch && !isSelf && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Users /> {t("people.menu.role", { name: roleLabel(u.role) })}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={u.role} onValueChange={(role) => { if (role !== u.role) actions.changeRole(u, role); }}>
                  {(isAdmin ? (["trader", "curator", "admin"] as const) : (["trader", "curator"] as const)).map((r) => (
                    <DropdownMenuRadioItem key={r} value={r}>{roleLabel(r)}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          {u.banned ? (
            <DropdownMenuItem onSelect={() => actions.unban(u)}><UserCheck /> {t("activity.menu.unban")}</DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={!canBan} onSelect={() => actions.ban(u)} className="text-down focus:text-down">
              <Ban /> {canBan ? t("activity.menu.ban") : isSelf ? t("activity.menu.cantSelf") : t("activity.menu.banUnavailable")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const days = pulse?.days ?? [];
  const journalAvailable = pulse?.journalAvailable ?? false;
  const violationsAvailable = pulse?.violationsAvailable ?? false;

  return (
    <Panel
      title={t("activity.title")}
      description={pulse ? t("activity.description", { date: pulse.date }) : undefined}
      icon={Users}
      actions={
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
          <Download /> CSV
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative w-full lg:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); } }}
              placeholder={t("activity.searchPlaceholder")}
              aria-label={t("activity.searchPlaceholder")}
              className="pl-9 pr-10"
            />
            <Kbd className="absolute right-3 top-1/2 -translate-y-1/2">/</Kbd>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("activity.filterAria")}>
            {FILTERS.filter((f) => !SIGNAL_FILTERS.has(f) || counts[f] > 0 || filter === f).map((f) => (
              <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)} count={counts[f]} className="shrink-0">
                {t(`activity.filter.${f}`)}
              </FilterChip>
            ))}
          </div>
        </div>

        {error ? (
          <QueryError error={error} onRetry={onRetry} />
        ) : isLoading ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label={commonI18n.t("states.loading")}>
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title={users.length === 0 ? t("people.emptyNone") : t("people.emptyFiltered")}
            description={users.length === 0 ? t("activity.emptyNoneHint") : t("people.emptyFilteredHint")}
            action={users.length > 0 ? <Button variant="outline" size="sm" onClick={() => { setQ(""); setFilter("all"); }}>{t("people.showAll")}</Button> : undefined}
          />
        ) : (
          <>
            {/* Desktop table */}
            <DataTable className="hidden md:block" maxHeight="65vh" ariaLabel={t("activity.tableAria")}>
              <table>
                <thead>
                  <tr>
                    <SortableTh {...thProps("name")}>{t("activity.col.trader")}</SortableTh>
                    <SortableTh {...thProps("lastSeen")}>{t("activity.col.lastSeen")}</SortableTh>
                    <SortableTh {...thProps("today")} align="right">{t("activity.col.today")}</SortableTh>
                    <SortableTh {...thProps("week")} align="right">{t("activity.col.week")}</SortableTh>
                    <th scope="col">{t("activity.col.days14")}</th>
                    {riskStatus && <th scope="col">{t("activity.col.risk")}</th>}
                    <SortableTh {...thProps("streak")}>{t("activity.col.streak")}</SortableTh>
                    <SortableTh {...thProps("violations")} align="right">{t("activity.col.violations")}</SortableTh>
                    <th scope="col"><span className="sr-only">{t("people.col.actions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr
                      key={u.id}
                      tabIndex={0}
                      onClick={() => setOpenName(u.name)}
                      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) setOpenName(u.name); }}
                      className={cn("group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", u.banned && "opacity-70")}
                    >
                      <td>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-foreground" title={personName(u.name)}>{personName(u.name)}</span>
                          {u.name === actor && <span className="text-2xs text-muted-foreground">{t("you")}</span>}
                          {u.role !== "trader" && <Pill tone={roleTone(u.role)}>{roleLabel(u.role)}</Pill>}
                          {u.banned && <Pill tone="down">{t("activity.banTag")}</Pill>}
                        </div>
                      </td>
                      <td>
                        <span className={cn("whitespace-nowrap", u.activeToday ? "text-foreground" : isStale(u) && !u.banned ? "text-[hsl(var(--chart-3))]" : "text-muted-foreground")} title={u.lastSeen ? fmtDate(u.lastSeen, "shortDateTimeSeconds") : undefined}>
                          {u.activeToday && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-up align-middle" aria-hidden="true" />}
                          {timeAgo(u.lastSeen)}
                        </span>
                      </td>
                      <td className="text-right font-semibold tabular-nums">{u.tradesToday || <span className="font-normal text-muted-foreground">0</span>}</td>
                      <td className="text-right tabular-nums">{u.tradesWeek}</td>
                      <td><ActivityStrip days={days} trades={u.tradeStrip} journal={journalAvailable ? u.journalStrip : undefined} size="sm" /></td>
                      {riskStatus && <td><RiskPill status={riskStatus.get(u.name)} /></td>}
                      <td><StreakCell u={u} journalAvailable={journalAvailable} /></td>
                      <td className="text-right"><ViolationsCell u={u} available={violationsAvailable} /></td>
                      <td className="w-10 text-right">{menu(u)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>

            {/* Mobile cards */}
            <ul className="flex flex-col gap-2 md:hidden">
              {rows.map((u) => (
                <li key={u.id} className="glass-panel group flex flex-col gap-2 rounded-xl p-3">
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" onClick={() => setOpenName(u.name)} className="min-w-0 text-left">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium" title={personName(u.name)}>{personName(u.name)}</span>
                        {u.role !== "trader" && <Pill tone={roleTone(u.role)}>{roleLabel(u.role)}</Pill>}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{timeAgo(u.lastSeen)}</div>
                    </button>
                    <div className="flex items-center gap-1"><StatusPill u={u} />{menu(u)}</div>
                  </div>
                  <ActivityStrip days={days} trades={u.tradeStrip} journal={journalAvailable ? u.journalStrip : undefined} />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span><span className="text-muted-foreground">{t("activity.mobileToday")}</span><b className="tabular-nums">{u.tradesToday}</b></span>
                    <span><span className="text-muted-foreground">{t("activity.mobileWeek")}</span><b className="tabular-nums">{u.tradesWeek}</b></span>
                    <StreakCell u={u} journalAvailable={journalAvailable} />
                    {violationsAvailable && u.violationsWeek > 0 && <Pill tone="warn">{t("activity.mobileViolations", { count: u.violationsWeek })}</Pill>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <TraderSheet
        user={open}
        days={days}
        journalAvailable={journalAvailable}
        violationsAvailable={violationsAvailable}
        actor={actor}
        isAdmin={isAdmin}
        onClose={() => setOpenName(null)}
        actions={actions}
        risk={open && riskStatus ? riskStatus.get(open.name) ?? null : undefined}
      />
      {actions.dialog}
    </Panel>
  );
}

function TraderSheet({
  user: u,
  days,
  journalAvailable,
  violationsAvailable,
  actor,
  isAdmin,
  onClose,
  actions,
  risk,
}: {
  risk?: RiskStatus | null;
  user: PulseUser | null;
  days: string[];
  journalAvailable: boolean;
  violationsAvailable: boolean;
  actor: string;
  isAdmin: boolean;
  onClose: () => void;
  actions: ReturnType<typeof useUserActions>;
}) {
  const { t } = adminI18n.useT();
  const isSelf = u?.name === actor;
  const canBan = !!u && !isSelf && u.role !== "admin" && (isAdmin || u.role !== "curator");
  const canTouch = !!u && (isAdmin || u.role !== "admin");
  // ~21 trading days in 30 calendar days.
  const journalPct = u ? Math.min(1, u.journal30 / 21) : 0;
  return (
    <Sheet open={!!u} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-lg">
        {u && (
          <>
            <SheetHeader className="gap-2 border-b border-[var(--glass-border)] p-5 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="text-lg">{personName(u.name)}</SheetTitle>
                <Pill tone={roleTone(u.role)}>{roleLabel(u.role)}</Pill>
                <StatusPill u={u} />
              </div>
              <SheetDescription>
                {t("activity.sheet.lastSeen", { ago: timeAgo(u.lastSeen) })}{u.lastSeen ? ` · ${fmtDate(u.lastSeen, "shortDateTimeSeconds")}` : ""}
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-5 p-5">
              {u.banned && (
                <div className="flex items-start gap-2 rounded-xl bg-down/10 p-3 text-sm text-down">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{u.bannedReason ? t("activity.sheet.bannedReason", { reason: u.bannedReason }) : t("activity.sheet.banned")}</span>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2">
                <div className="glass-panel rounded-xl p-3">
                  <div className="text-xs text-muted-foreground">{t("activity.sheet.today")}</div>
                  <div className="text-2xl font-semibold tabular-nums">{u.tradesToday}</div>
                  <div className="text-2xs text-muted-foreground">{t("activity.sheet.tradesWord", { count: u.tradesToday })}</div>
                </div>
                <div className="glass-panel rounded-xl p-3">
                  <div className="text-xs text-muted-foreground">{t("activity.sheet.week")}</div>
                  <div className="text-2xl font-semibold tabular-nums">{u.tradesWeek}</div>
                  <div className="text-2xs text-muted-foreground">{t("activity.sheet.tradesWord", { count: u.tradesWeek })}</div>
                </div>
                <div className="glass-panel flex flex-col items-center justify-center rounded-xl p-3">
                  <ProgressRing value={journalPct * 100} tone={journalPct >= 0.8 ? "up" : journalPct >= 0.4 ? "warn" : "down"} label={u.journal30} ariaLabel={t("activity.sheet.journal30Aria", { count: u.journal30 })} />
                  <div className="mt-1 text-2xs text-muted-foreground">{t("activity.sheet.journal30")}</div>
                </div>
              </div>

              <section className="flex flex-col gap-2">
                <h3 className="micro-label">{t("activity.sheet.last14")}</h3>
                <ActivityStrip days={days} trades={u.tradeStrip} journal={journalAvailable ? u.journalStrip : undefined} />
              </section>

              <section className="flex flex-col">
                <h3 className="micro-label mb-1">{t("activity.sheet.discipline")}</h3>
                {risk !== undefined && <StatRow label={t("activity.sheet.riskToday")} value={<RiskPill status={risk ?? undefined} />} />}
                <StatRow label={t("activity.sheet.lastTradeDay")} value={u.lastTradeDate ?? "—"} />
                {journalAvailable && <StatRow label={t("activity.sheet.journalToday")} value={u.journalToday ? t("activity.sheet.filled") : t("activity.noEntry")} tone={u.journalToday ? "up" : u.role === "trader" ? "warn" : "neutral"} />}
                {journalAvailable && <StatRow label={t("activity.sheet.streak")} value={t("activity.sheet.days", { count: u.notesStreak })} />}
                {violationsAvailable && (
                  <>
                    <StatRow label={t("activity.sheet.violationsToday")} value={u.violationsToday} tone={u.violationsToday > 0 ? "down" : "neutral"} />
                    <StatRow label={t("activity.sheet.violationsWeek")} value={u.violationsHighWeek ? t("activity.sheet.violationsHigh", { count: u.violationsWeek, high: u.violationsHighWeek }) : u.violationsWeek} tone={u.violationsWeek > 0 ? "warn" : "neutral"} />
                    <StatRow label={t("activity.sheet.violationsTotal")} value={u.violationsTotal} />
                  </>
                )}
                <StatRow label={t("activity.sheet.since")} value={u.createdAt ? fmtDate(u.createdAt, "short") : "—"} />
              </section>

              <section className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm"><Link href="/journal"><BookOpen /> {t("activity.sheet.journal")}</Link></Button>
                <Button asChild variant="outline" size="sm"><Link href="/error-tracker"><CalendarCheck /> {t("activity.sheet.rules")}</Link></Button>
                <Button asChild variant="outline" size="sm"><Link href="/ratings"><Flame /> {t("activity.sheet.ratings")}</Link></Button>
              </section>

              <section className="flex flex-col gap-2 border-t border-[var(--glass-border)] pt-4">
                <h3 className="micro-label">{t("activity.sheet.manage")}</h3>
                <div className="flex flex-wrap gap-2">
                  {canTouch && <Button variant="outline" size="sm" onClick={() => actions.setPassword(u)}><KeyRound /> {t("activity.sheet.password")}</Button>}
                  {canTouch && !isSelf && (isAdmin ? (["trader", "curator", "admin"] as const) : (["trader", "curator"] as const)).filter((r) => r !== u.role).map((r) => (
                    <Button key={r} variant="outline" size="sm" onClick={() => actions.changeRole(u, r)}><UserCog /> {t("activity.sheet.makeRole", { role: roleLabel(r).toLowerCase() })}</Button>
                  ))}
                  {u.banned ? (
                    <Button variant="outline" size="sm" onClick={() => actions.unban(u)}><UserCheck /> {t("activity.sheet.unban")}</Button>
                  ) : (
                    <Button variant="destructive" size="sm" disabled={!canBan} onClick={() => actions.ban(u)}><Ban /> {t("activity.sheet.ban")}</Button>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
