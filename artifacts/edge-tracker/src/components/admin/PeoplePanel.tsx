/**
 * «Люди» — accounts management for the desk owner: role, tier, curator, PropReports accounts, status, activity.
 * Every change asks for a reason (ReasonDialog) and lands in the audit log. Status: active / frozen (banned,
 * login blocked) / archived (active=false, soft — nothing is deleted).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  Archive, ArchiveRestore, Download, GraduationCap, KeyRound, Languages, Link2, LogOut, MoreHorizontal, Search, Snowflake, Sun,
  UserCog, UserPlus, Users, UsersRound, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { QueryError } from "@/components/query-error";
import {
  DataTable, EmptyState, FilterChip, Kbd, Panel, Pill, Segmented, SortableTh, TableSkeleton, useTableSort, type Tone,
} from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { cn } from "@/lib/utils";
import { downloadCsv, isTypingTarget, roleLabel, tierDisplayName, tierFallbackLabel, timeAgo, type DeskPulse } from "./api";
import {
  NotDeployedError, useCreatePerson, useMapAccount, usePeople, usePeopleAction, useSetNameLatin, useTiers,
  type PeopleActionInput, type PeopleActionKind, type Person, type PersonStatus,
} from "./console-api";
import { ReasonDialog, type ReasonDialogState } from "./ReasonDialog";
import { TradersTable, type RiskStatus, type TraderFilter } from "./TradersTable";
import { useUserActions } from "./useUserActions";
import { profileHref } from "@/components/curator/curator-math";
import { PersonSelect } from "@/components/people/person-select";
import { Highlight } from "@/components/people/highlight";
import { matchText, prepareQuery } from "@/components/people/search";
import { fmtDate } from "@/lib/format";
import { secretMinFor } from "@/lib/secret-policy";
import { authI18n } from "@/i18n/ns/auth";
import { adminI18n } from "@/i18n/ns/admin";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";
import { FillLatinButton, LatinSuggestion, NameLatinDialog } from "./latin-names";

export type PeopleView = "manage" | "activity";
type Filter = "all" | "traders" | "staff" | "active" | "frozen" | "archived" | "nocurator" | "noaccount";

const FILTERS: readonly Filter[] = ["all", "traders", "staff", "active", "frozen", "archived", "nocurator", "noaccount"];
/** Problem filters: shown only when they match someone (or are selected) — fewer chips at once. */
const SIGNAL_FILTERS = new Set<Filter>(["frozen", "nocurator", "noaccount"]);

/** Built-in tier ladder keys (names: adminI18n `tier.*`), used until /tiers answers. */
const TIER_FALLBACK_KEYS = ["trainee", "junior", "trader", "senior", "lead"] as const;

const STATUS_TONE: Record<PersonStatus, Tone> = { active: "up", frozen: "warn", archived: "neutral" };
const statusLabel = (s: PersonStatus) => adminI18n.t(`people.status.${s}`);

/** Quick-pick reasons in the UI language (stored as typed). */
const presets = (kind: PeopleActionKind | "map") => adminI18n.t(`people.presets.${kind}`).split("|");

function matches(p: Person, f: Filter) {
  switch (f) {
    case "traders": return p.role === "trader";
    case "staff": return p.role !== "trader";
    case "active": return p.status === "active";
    case "frozen": return p.status === "frozen";
    case "archived": return p.status === "archived";
    case "nocurator": return p.role === "trader" && p.status !== "archived" && !p.curator;
    case "noaccount": return p.role === "trader" && p.status !== "archived" && p.accounts.length === 0;
    default: return true;
  }
}

function roleTone(role: string): Tone {
  return role === "admin" ? "purple" : role === "curator" ? "accent" : "neutral";
}

type Row = Person & { seen: string | null };
const ACCESSORS = {
  name: (p: Row) => personName(p.name),
  role: (p: Row) => (p.role === "admin" ? 0 : p.role === "curator" ? 1 : 2),
  tier: (p: Row) => p.tier ?? null,
  curator: (p: Row) => (p.curator ? personName(p.curator) : null),
  status: (p: Row) => p.status,
  seen: (p: Row) => (p.seen ? Date.parse(p.seen) : null),
  trades: (p: Row) => p.trades30,
};

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function PeoplePanel({
  actor, pulse, pulseLoading, pulseError, onPulseRetry, riskStatus, view, onViewChange, activityFilter, onActivityFilterChange,
}: {
  actor: string;
  pulse: DeskPulse | undefined;
  pulseLoading: boolean;
  pulseError: unknown;
  onPulseRetry: () => void;
  riskStatus?: Map<string, RiskStatus>;
  view: PeopleView;
  onViewChange: (v: PeopleView) => void;
  activityFilter: TraderFilter;
  onActivityFilterChange: (f: TraderFilter) => void;
}) {
  const { can, isAdmin, refreshUsers } = useAuth();
  const { toast } = useToast();
  const { t } = adminI18n.useT();
  const tc = commonI18n.t;
  const people = usePeople();
  const tiers = useTiers();
  const action = usePeopleAction(actor);
  const create = useCreatePerson();
  const mapAccount = useMapAccount();
  const legacy = useUserActions(actor, refreshUsers);

  const canManage = can("users.manage");
  const canAdmins = can("users.manage.admins");
  const canTier = can("scaling.approve");
  const canMap = can("propreports.configure");

  const [filter, setFilter] = useState<Filter>("active");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<ReasonDialogState>(null);
  const [addOpen, setAddOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== "manage") return;
      if (e.key === "/" && !isTypingTarget(e.target) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  const tierName = useMemo(() => {
    const m: Record<string, string> = Object.fromEntries(TIER_FALLBACK_KEYS.map((k) => [k, tierFallbackLabel(k)]));
    for (const x of tiers.data ?? []) m[x.key] = tierDisplayName(x.key, x.name);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` changes with the language
  }, [tiers.data, t]);
  const tierList = tiers.data?.length ? tiers.data.map((x) => ({ ...x, name: tierDisplayName(x.key, x.name) })) : TIER_FALLBACK_KEYS.slice(0, 4).map((key, i) => ({ key, name: tierFallbackLabel(key), order: i + 1 }));

  const seenBy = useMemo(() => new Map((pulse?.users ?? []).map((u) => [u.name, u.lastSeen])), [pulse]);
  const all: Row[] = useMemo(
    () => (people.data?.people ?? []).map((p) => ({ ...p, seen: later(p.lastSeen, seenBy.get(p.name) ?? null) })),
    [people.data, seenBy],
  );
  const curators = useMemo(() => all.filter((p) => p.role !== "trader" && p.status === "active").map((p) => p.name), [all]);
  const traderNames = useMemo(() => all.filter((p) => p.status === "active").map((p) => p.name), [all]);

  const counts = useMemo(() => {
    const c = {} as Record<Filter, number>;
    for (const f of FILTERS) c[f] = all.filter((p) => matches(p, f)).length;
    return c;
  }, [all]);
  // Cross-script search (RU / EN / UZ, wrong keyboard layout, typos): name, Latin alias, curator, accounts.
  const pq = useMemo(() => prepareQuery(q), [q]);
  const hitBy = useMemo(() => {
    const m = new Map<number, { ranges: [number, number][]; latin: boolean }>();
    if (pq.empty) return m;
    for (const p of all) {
      const byName = matchText(pq, p.name);
      const byLatin = matchText(pq, p.nameLatin);
      if (byName || byLatin) m.set(p.id, { ranges: (byName ?? byLatin)!.ranges, latin: !byName });
      else if (matchText(pq, p.curator) || p.accounts.some((a) => matchText(pq, a))) m.set(p.id, { ranges: [], latin: false });
    }
    return m;
  }, [all, pq]);
  const filtered = useMemo(() => all.filter((p) => matches(p, filter) && (pq.empty || hitBy.has(p.id))), [all, filter, pq, hitBy]);
  // Main line: the name as shown (Latin in EN/UZ when set); second line: the other spelling, if any.
  const nameOf = (p: Person) => { const main = personName(p.name); return { main, latinMain: main !== p.name, other: main !== p.name ? p.name : p.nameLatin || null }; };
  const rangesOf = (p: Person, main: boolean) => { const h = hitBy.get(p.id); return h && h.latin === (nameOf(p).latinMain === main) ? h.ranges : null; };
  const groupSize = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of all) if (p.role === "trader" && p.status === "active" && p.curator) m.set(p.curator, (m.get(p.curator) ?? 0) + 1);
    return m;
  }, [all]);
  const setLatin = useSetNameLatin();
  const [latinFor, setLatinFor] = useState<Person | null>(null);
  const { rows, thProps } = useTableSort(filtered, ACCESSORS, "role", "asc");

  // Selection only keeps visible rows.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const allChecked = rows.length > 0 && selectedRows.length === rows.length;

  /* ── actions ── */

  const run = (input: PeopleActionInput, success: string) => {
    action.mutate(input, {
      onSuccess: (r) => {
        setDialog(null);
        setSelected(new Set());
        refreshUsers();
        if (r.skipped.length) {
          toast({
            title: t("people.partial", { action: success, done: r.done.length, total: r.done.length + r.skipped.length }),
            description: r.skipped.slice(0, 4).map((s) => `${s.name ? personName(s.name) : "?"} — ${s.error}`).join("; "),
          });
        } else {
          toast({ title: success, description: r.done.map(personName).join(", ") });
        }
      },
      onError: (e) => {
        if (e instanceof NotDeployedError) setDialog(null);
        toast({ title: e instanceof NotDeployedError ? t("needRestart") : tc("states.error"), description: e.message, variant: "destructive" });
      },
    });
  };

  const ask = (kind: PeopleActionKind, targets: Person[], opts: { curator?: string | null; role?: string; tierKey?: string } = {}) => {
    const who = targets.length === 1 ? personName(targets[0]!.name) : t("people.who", { count: targets.length });
    const simple = (k: "freeze" | "unfreeze" | "archive" | "restore" | "sessions") => ({
      title: t(`people.ask.${k}.title`, { who }), description: t(`people.ask.${k}.text`), confirm: t(`people.ask.${k}.confirm`), success: t(`people.ask.${k}.done`),
    });
    const curatorFor = t("people.ask.curatorFor", { names: targets.map((x) => personName(x.name)).join(", ") });
    const curatorShown = personName(opts.curator);
    const meta: Record<PeopleActionKind, { title: string; description: string; confirm: string; destructive?: boolean; success: string }> = {
      freeze: { ...simple("freeze"), destructive: true },
      unfreeze: simple("unfreeze"),
      archive: { ...simple("archive"), destructive: true },
      restore: simple("restore"),
      sessions: simple("sessions"),
      curator: opts.curator
        ? { title: t("people.ask.curatorSet.title", { curator: curatorShown }), description: curatorFor, confirm: t("people.ask.curatorSet.confirm"), success: t("people.ask.curatorSet.done", { curator: curatorShown }) }
        : { title: t("people.ask.curatorClear.title"), description: curatorFor, confirm: t("people.ask.curatorClear.confirm"), success: t("people.ask.curatorClear.done") },
      role: { title: t("people.ask.role.title", { who }), description: t("people.ask.role.text", { from: roleLabel(targets[0]?.role), to: roleLabel(opts.role) }), confirm: t("people.ask.role.confirm"), success: t("people.ask.role.done") },
      tier: { title: t("people.ask.tier.title", { tier: tierName[opts.tierKey ?? ""] ?? opts.tierKey ?? "", who }), description: t("people.ask.tier.text"), confirm: t("people.ask.tier.confirm"), success: t("people.ask.tier.done") },
    };
    const m = meta[kind];
    setDialog({
      title: m.title,
      description: m.description,
      confirmLabel: m.confirm,
      destructive: m.destructive,
      input: { label: t("people.reasonLabel"), kind: "textarea", required: true, minLength: 3, presets: presets(kind), placeholder: t("people.reasonPlaceholder") },
      onConfirm: (reason) => run({ kind, people: targets, reason, ...opts }, m.success),
    });
  };

  const askMap = (account: string, trader: string) => setDialog({
    title: t("people.map.title", { account, trader: personName(trader) }),
    description: t("people.map.text"),
    confirmLabel: t("people.map.confirm"),
    input: { label: t("people.reasonLabel"), kind: "textarea", required: true, minLength: 3, presets: presets("map"), placeholder: t("people.reasonPlaceholder") },
    onConfirm: (reason) => mapAccount.mutate({ account, trader, reason }, {
      onSuccess: (r) => { setDialog(null); toast({ title: t("people.map.done", { account, trader: personName(trader) }), description: r.legacy ? t("people.map.legacy") : undefined }); },
      onError: (e) => toast({ title: tc("states.error"), description: e.message, variant: "destructive" }),
    }),
  });

  const canTouch = (p: Person) => canManage && (p.role !== "admin" || canAdmins);
  const isSelf = (p: Person) => p.name === actor;

  const exportCsv = () => downloadCsv(
    (["name", "latin", "role", "tier", "curator", "accounts", "status", "seen", "trades", "lastTrade", "created"] as const).map((k) => t(`people.csv.${k}`)),
    rows.map((p) => [p.name, p.nameLatin ?? "", roleLabel(p.role), p.tier ? tierName[p.tier] ?? p.tier : "", personName(p.curator), p.accounts.join(" "), statusLabel(p.status), p.seen ?? "", p.trades30, p.lastTrade ?? "", p.createdAt ?? ""]),
    `people-${new Date().toISOString().slice(0, 10)}.csv`,
  );

  const menu = (p: Row) => {
    const self = isSelf(p);
    const touch = canTouch(p);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("people.menu.aria", { name: personName(p.name) })} disabled={!touch && !canTier}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-xs text-muted-foreground">{personName(p.name)}</DropdownMenuLabel>
          {touch && p.role === "trader" && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><UserCog /> {t("people.menu.curator", { name: p.curator ? personName(p.curator) : t("people.menu.none") })}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={p.curator ?? ""} onValueChange={(c) => { if (c !== (p.curator ?? "")) ask("curator", [p], { curator: c || null }); }}>
                  {curators.map((c) => <DropdownMenuRadioItem key={c} value={c}>{personName(c)}</DropdownMenuRadioItem>)}
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioItem value="">{t("people.menu.noCurator")}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {canTier && p.role === "trader" && p.status === "active" && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><GraduationCap /> {t("people.menu.tier", { name: p.tier ? tierName[p.tier] ?? p.tier : t("people.menu.none") })}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={p.tier ?? ""} onValueChange={(k) => { if (k && k !== p.tier) ask("tier", [p], { tierKey: k }); }}>
                  {tierList.map((x) => <DropdownMenuRadioItem key={x.key} value={x.key}>{x.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {touch && !self && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Users /> {t("people.menu.role", { name: roleLabel(p.role) })}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={p.role} onValueChange={(r) => { if (r !== p.role) ask("role", [p], { role: r }); }}>
                  {(canAdmins ? ["trader", "curator", "admin"] : ["trader", "curator"]).map((r) => (
                    <DropdownMenuRadioItem key={r} value={r}>{roleLabel(r)}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {touch && <DropdownMenuItem onSelect={() => window.setTimeout(() => setLatinFor(p), 0)}><Languages /> {t("people.menu.latin")}</DropdownMenuItem>}
          {touch && <DropdownMenuItem onSelect={() => legacy.setPassword(p)}><KeyRound /> {t("people.menu.password")}</DropdownMenuItem>}
          {touch && <DropdownMenuItem onSelect={() => ask("sessions", [p])}><LogOut /> {t("people.menu.sessions")}</DropdownMenuItem>}
          {touch && !self && (
            <>
              <DropdownMenuSeparator />
              {p.status === "frozen"
                ? <DropdownMenuItem onSelect={() => ask("unfreeze", [p])}><Sun /> {t("people.menu.unfreeze")}</DropdownMenuItem>
                : p.status === "active" && p.role !== "admin" && (p.role !== "curator" || canAdmins) && (
                  <DropdownMenuItem onSelect={() => ask("freeze", [p])} className="text-[hsl(var(--chart-3))] focus:text-[hsl(var(--chart-3))]"><Snowflake /> {t("people.menu.freeze")}</DropdownMenuItem>
                )}
              {p.status === "archived"
                ? <DropdownMenuItem onSelect={() => ask("restore", [p])}><ArchiveRestore /> {t("people.menu.restore")}</DropdownMenuItem>
                : (p.role !== "curator" || canAdmins) && <DropdownMenuItem onSelect={() => ask("archive", [p])} className="text-down focus:text-down"><Archive /> {t("people.menu.archive")}</DropdownMenuItem>}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const unmatched = [
    ...(people.data?.accounts.unmatched ?? []).map((a) => ({ account: a, kind: "new" as const })),
    ...(people.data?.accounts.unmapped ?? []).map((a) => ({ account: a.account, kind: "unmapped" as const })),
  ];

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented<PeopleView>
          ariaLabel={t("people.viewAria")}
          value={view}
          onChange={onViewChange}
          options={[{ value: "manage", label: t("people.view.manage") }, { value: "activity", label: t("people.view.activity") }]}
        />
        {view === "manage" && people.data?.source === "fallback" && (
          <span className="text-xs text-muted-foreground">{t("people.fallbackNote")}</span>
        )}
      </div>

      {view === "activity" ? (
        <TradersTable
          actor={actor}
          isAdmin={isAdmin}
          pulse={pulse}
          isLoading={pulseLoading}
          error={pulseError}
          onRetry={onPulseRetry}
          onChange={refreshUsers}
          filter={activityFilter}
          onFilterChange={onActivityFilterChange}
          riskStatus={riskStatus}
        />
      ) : (
        <>
          {canMap && unmatched.length > 0 && (
            <Panel title={t("people.unmatched.title")} icon={Link2} description={t("people.unmatched.description")}>
              <ul className="flex flex-col gap-2">
                {unmatched.map((u) => <AccountMatchRow key={`${u.kind}:${u.account}`} account={u.account} isNew={u.kind === "new"} traders={traderNames} onMap={askMap} />)}
              </ul>
            </Panel>
          )}

          <Panel
            title={t("people.title")}
            icon={Users}
            description={t("people.description")}
            actions={
              <>
                {canManage && <FillLatinButton people={all.filter(canTouch)} />}
                <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}><Download /> CSV</Button>
                {canManage && <Button size="sm" onClick={() => setAddOpen(true)}><UserPlus /> {t("people.add")}</Button>}
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <div className="relative w-full md:max-w-sm">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    ref={searchRef}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); } }}
                    placeholder={t("people.searchPlaceholder")}
                    title={t("people.searchTitle")}
                    aria-label={t("people.searchAria")}
                    className="pl-9 pr-10"
                  />
                  <Kbd className="absolute right-3 top-1/2 -translate-y-1/2">/</Kbd>
                </div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("people.filterAria")}>
                  {FILTERS.filter((f) => !SIGNAL_FILTERS.has(f) || counts[f] > 0 || filter === f).map((f) => (
                    <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)} count={counts[f]} className="shrink-0">
                      {t(`people.filter.${f}`)}
                    </FilterChip>
                  ))}
                </div>
              </div>

              {selectedRows.length > 0 && (
                <BulkBar
                  count={selectedRows.length}
                  curators={curators}
                  tiers={canTier ? tierList : []}
                  tierEligible={selectedRows.filter((r) => r.role === "trader" && r.status === "active").length}
                  onClear={() => setSelected(new Set())}
                  onAction={(kind, opts) => ask(kind, kind === "tier" ? selectedRows.filter((r) => r.role === "trader" && r.status === "active") : selectedRows, opts)}
                  canManage={canManage}
                />
              )}

              {people.isError ? (
                <QueryError error={people.error} onRetry={() => people.refetch()} />
              ) : people.isLoading ? (
                <TableSkeleton rows={6} cols={7} />
              ) : rows.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title={all.length === 0 ? t("people.emptyNone") : t("people.emptyFiltered")}
                  description={all.length === 0 ? t("people.emptyNoneHint") : t("people.emptyFilteredHint")}
                  action={all.length > 0 ? <Button variant="outline" size="sm" onClick={() => { setQ(""); setFilter("all"); }}>{t("people.showAll")}</Button> : undefined}
                />
              ) : (
                <DataTable maxHeight="65vh" ariaLabel={t("people.tableAria")}>
                  <table>
                    <thead>
                      <tr>
                        {canManage && (
                          <th scope="col" className="w-8">
                            <Checkbox
                              checked={allChecked ? true : selectedRows.length ? "indeterminate" : false}
                              onCheckedChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())}
                              aria-label={t("people.selectAll")}
                            />
                          </th>
                        )}
                        <SortableTh {...thProps("name")}>{t("people.col.name")}</SortableTh>
                        <SortableTh {...thProps("role")}>{t("people.col.role")}</SortableTh>
                        <SortableTh {...thProps("tier")}>{t("people.col.tier")}</SortableTh>
                        <SortableTh {...thProps("curator")}>{t("people.col.curator")}</SortableTh>
                        <th scope="col">{t("people.col.accounts")}</th>
                        <SortableTh {...thProps("status")}>{t("people.col.status")}</SortableTh>
                        <SortableTh {...thProps("seen")}>{t("people.col.seen")}</SortableTh>
                        <SortableTh {...thProps("trades")} align="right">{t("people.col.trades")}</SortableTh>
                        <th scope="col"><span className="sr-only">{t("people.col.actions")}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.id} className={cn(p.status === "archived" && "opacity-60", selected.has(p.id) && "bg-[var(--glass-bg)]")}>
                          {canManage && (
                            <td>
                              <Checkbox
                                checked={selected.has(p.id)}
                                onCheckedChange={(v) => setSelected((prev) => { const n = new Set(prev); if (v) n.add(p.id); else n.delete(p.id); return n; })}
                                aria-label={t("people.selectOne", { name: personName(p.name) })}
                              />
                            </td>
                          )}
                          <td>
                            <div className="flex min-w-0 items-center gap-1.5">
                              {p.role === "trader" ? (
                                <Link href={profileHref(p.name)} className="truncate rounded font-medium text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={t("people.profileTitle", { name: nameOf(p).main })}>
                                  <Highlight text={nameOf(p).main} ranges={rangesOf(p, true)} />
                                </Link>
                              ) : (
                                <span className="truncate font-medium text-foreground" title={nameOf(p).main}><Highlight text={nameOf(p).main} ranges={rangesOf(p, true)} /></span>
                              )}
                              {isSelf(p) && <span className="text-2xs text-muted-foreground">{t("you")}</span>}
                              {p.role !== "trader" && (groupSize.get(p.name) ?? 0) > 0 && (
                                <Link href={`/curator?view=traders&group=${encodeURIComponent(p.name)}`} title={t("people.groupTitle", { name: personName(p.name) })} className="chip inline-flex h-6 shrink-0 items-center gap-1 px-2 text-2xs tabular-nums">
                                  <UsersRound className="h-3 w-3" aria-hidden="true" />{t("people.group", { count: groupSize.get(p.name) ?? 0 })}
                                </Link>
                              )}
                            </div>
                            {nameOf(p).other ? (
                              <div className="truncate text-2xs text-muted-foreground" title={nameOf(p).latinMain ? undefined : t("people.latinHint")}>
                                <Highlight text={nameOf(p).other!} ranges={rangesOf(p, false)} />
                              </div>
                            ) : canTouch(p) && <LatinSuggestion person={p} onEdit={() => setLatinFor(p)} />}
                          </td>
                          <td><Pill tone={roleTone(p.role)}>{roleLabel(p.role)}</Pill></td>
                          <td>{p.role === "trader" ? (p.tier ? <span>{tierName[p.tier] ?? p.tier}</span> : <span className="text-muted-foreground">—</span>) : <span className="text-muted-foreground">—</span>}</td>
                          <td>{p.role === "trader" ? (p.curator ? personName(p.curator) : <span className="whitespace-nowrap text-[hsl(var(--chart-3))]">{t("people.curatorNotSet")}</span>) : <span className="text-muted-foreground">—</span>}</td>
                          <td>
                            {p.accounts.length
                              ? <span className="font-mono text-xs tabular-nums" title={p.accounts.join(", ")}>{p.accounts.slice(0, 2).join(", ")}{p.accounts.length > 2 ? ` +${p.accounts.length - 2}` : ""}</span>
                              : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td>
                            <Pill tone={STATUS_TONE[p.status]} dot={p.status !== "archived"}>{statusLabel(p.status)}</Pill>
                            {p.status === "frozen" && p.bannedReason && <div className="max-w-[16rem] whitespace-normal break-words text-2xs text-muted-foreground">{p.bannedReason}</div>}
                          </td>
                          <td className="whitespace-nowrap text-muted-foreground" title={p.seen ? fmtDate(p.seen, "shortDateTimeSeconds") : undefined}>{timeAgo(p.seen)}</td>
                          <td className="text-right tabular-nums">{p.trades30 || <span className="text-muted-foreground">0</span>}</td>
                          <td className="w-10 text-right">{menu(p)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              )}
            </div>
          </Panel>
        </>
      )}

      <ReasonDialog state={dialog} onClose={() => setDialog(null)} busy={action.isPending || mapAccount.isPending} />
      <NameLatinDialog
        person={latinFor}
        busy={setLatin.isPending}
        onClose={() => setLatinFor(null)}
        onSave={(value) => latinFor && setLatin.mutate({ id: latinFor.id, nameLatin: value }, {
          onSuccess: (r) => { setLatinFor(null); refreshUsers(); toast({ title: r.nameLatin ? t("people.latin.saved", { name: personName(r.name) }) : t("people.latin.removed", { name: personName(r.name) }) }); },
          onError: (e) => toast({ title: e instanceof NotDeployedError ? t("needRestart") : tc("states.error"), description: e.message, variant: "destructive" }),
        })}
      />
      {legacy.dialog}
      <AddPersonDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        curators={curators}
        canAdmins={canAdmins}
        busy={create.isPending}
        onSubmit={(body) => create.mutate(body, {
          onSuccess: (u) => { setAddOpen(false); refreshUsers(); toast({ title: t("people.addDialog.done", { name: personName(u.name) }), description: t("people.addDialog.doneHint") }); },
          onError: (e) => toast({ title: e instanceof NotDeployedError ? t("needRestart") : tc("states.error"), description: e instanceof NotDeployedError ? t("people.addDialog.fallbackHint", { message: e.message }) : e.message, variant: "destructive" }),
        })}
      />
    </div>
  );
}

function AccountMatchRow({ account, isNew, traders, onMap }: { account: string; isNew: boolean; traders: string[]; onMap: (account: string, trader: string) => void }) {
  const { t } = adminI18n.useT();
  const [trader, setTrader] = useState("");
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--glass-bg)] p-3">
      <span className="font-mono text-sm tabular-nums">{account}</span>
      <Pill tone={isNew ? "warn" : "neutral"}>{isNew ? t("people.unmatched.isNew") : t("people.unmatched.noTrader")}</Pill>
      <div className="ml-auto flex items-center gap-2">
        <PersonSelect value={trader} onValueChange={setTrader} options={traders} placeholder={t("people.unmatched.whose")} ariaLabel={t("people.unmatched.traderFor", { account })} className="h-9 w-[180px]" align="end" />
        <Button size="sm" disabled={!trader} onClick={() => onMap(account, trader)}>{t("people.unmatched.map")}</Button>
      </div>
    </li>
  );
}

function BulkBar({
  count, curators, tiers, tierEligible, onClear, onAction, canManage,
}: {
  count: number;
  curators: string[];
  /** Tier ladder when the viewer may assign tiers (scaling.approve), else empty. */
  tiers: { key: string; name: string }[];
  /** Selected active traders — the only rows a tier applies to. */
  tierEligible: number;
  onClear: () => void;
  onAction: (kind: PeopleActionKind, opts?: { curator?: string | null; tierKey?: string }) => void;
  canManage: boolean;
}) {
  const { t } = adminI18n.useT();
  return (
    <div className="sticky-top flex flex-wrap items-center gap-2 rounded-xl border border-[var(--glass-border)] p-2" role="toolbar" aria-label={t("people.bulk.aria")}>
      <span className="px-2 text-sm font-medium tabular-nums">{t("people.bulk.selected", { count })}</span>
      {canManage && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><UserCog /> {t("people.bulk.curator")}</Button></DropdownMenuTrigger>
            <DropdownMenuContent>
              {curators.map((c) => <DropdownMenuItem key={c} onSelect={() => onAction("curator", { curator: c })}>{personName(c)}</DropdownMenuItem>)}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onAction("curator", { curator: null })}>{t("people.menu.noCurator")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={() => onAction("freeze")}><Snowflake /> {t("people.bulk.freeze")}</Button>
          <Button variant="outline" size="sm" onClick={() => onAction("unfreeze")}><Sun /> {t("people.bulk.unfreeze")}</Button>
          <Button variant="outline" size="sm" onClick={() => onAction("archive")}><Archive /> {t("people.bulk.archive")}</Button>
          <Button variant="outline" size="sm" onClick={() => onAction("restore")}><ArchiveRestore /> {t("people.bulk.restore")}</Button>
          <Button variant="outline" size="sm" onClick={() => onAction("sessions")}><LogOut /> {t("people.bulk.sessions")}</Button>
        </>
      )}
      {tiers.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={!tierEligible} title={tierEligible ? t("people.bulk.tierTitle", { count: tierEligible }) : t("people.bulk.tierDisabled")}>
              <GraduationCap /> {t("people.bulk.tier")}{tierEligible && tierEligible !== count ? ` · ${tierEligible}` : ""}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t("people.bulk.tierLabel", { count: tierEligible })}</DropdownMenuLabel>
            {tiers.map((x) => <DropdownMenuItem key={x.key} onSelect={() => onAction("tier", { tierKey: x.key })}>{x.name}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button variant="ghost" size="sm" className="ml-auto" onClick={onClear}><X /> {t("people.bulk.clear")}</Button>
    </div>
  );
}

function AddPersonDialog({
  open, onOpenChange, curators, canAdmins, busy, onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  curators: string[];
  canAdmins: boolean;
  busy: boolean;
  onSubmit: (body: { name: string; password: string; role: string; curator: string | null; reason: string }) => void;
}) {
  const { t } = adminI18n.useT();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("trader");
  const [curator, setCurator] = useState("");
  const [reason, setReason] = useState(() => t("people.addDialog.reasonDefault"));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  useEffect(() => { if (open) { setName(""); setPassword(""); setRole("trader"); setCurator(""); setReason(t("people.addDialog.reasonDefault")); } }, [open]);
  const minSecret = secretMinFor(role);
  const valid = name.trim().length > 0 && password.length >= minSecret && reason.trim().length >= 3;
  const submit = () => { if (valid && !busy) onSubmit({ name: name.trim(), password, role, curator: role === "trader" && curator ? curator : null, reason: reason.trim() }); };
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-4" autoComplete="off">
          <DialogHeader>
            <DialogTitle>{t("people.addDialog.title")}</DialogTitle>
            <DialogDescription>{t("people.addDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="np-name" className="text-xs text-muted-foreground">{t("people.addDialog.name")} <span className="text-down">*</span></Label>
              <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="np-pass" className="text-xs text-muted-foreground">{t("people.addDialog.password")} <span className="text-down">*</span></Label>
              <Input id="np-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={authI18n.t("forced.tooShort", { min: minSecret })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">{t("people.addDialog.role")}</Label>
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger aria-label={t("people.addDialog.role")}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trader">{roleLabel("trader")}</SelectItem>
                    <SelectItem value="curator">{roleLabel("curator")}</SelectItem>
                    {canAdmins && <SelectItem value="admin">{roleLabel("admin")}</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">{t("people.addDialog.curator")}</Label>
                <Select value={curator || "__none"} onValueChange={(v) => setCurator(v === "__none" ? "" : v)} disabled={role !== "trader"}>
                  <SelectTrigger aria-label={t("people.addDialog.curator")}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t("people.addDialog.noCurator")}</SelectItem>
                    {curators.map((c) => <SelectItem key={c} value={c}>{personName(c)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="np-reason" className="text-xs text-muted-foreground">{t("people.addDialog.reason")} <span className="text-down">*</span></Label>
              <Input id="np-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{commonI18n.t("actions.cancel")}</Button>
            <Button type="submit" disabled={!valid || busy}>{busy ? t("people.addDialog.creating") : commonI18n.t("actions.create")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
