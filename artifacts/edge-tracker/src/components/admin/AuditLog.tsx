import { useEffect, useMemo, useState } from "react";
import { Download, ScrollText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryError } from "@/components/query-error";
import { EmptyState, ListSkeleton, Panel, Pill, Segmented } from "@/components/ds";
import { addDays, nyDate } from "@/lib/trading-date";
import { downloadCsv, type AuditEntry } from "./api";
import { actorName, auditSentence, describeAudit, objectLabel, objectTypeLabel } from "./audit-text";
import { nyDayOf, useAuditSearch, type AuditQuery } from "./console-api";
import { fmtDate, fmtDateCustom, fmtTimeNY } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { adminAuditI18n } from "@/i18n/ns/adminAudit";

const ALL = "__all";
type Quick = "1" | "7" | "30" | "all" | "custom";

/** Action groups for the «Что» filter («user.*» matches every user action). */
const ACTION_GROUPS = ["user", "propreports", "scaling", "report", "academy"] as const;

function rangeFor(q: Quick): { from?: string; to?: string } {
  const today = nyDate();
  if (q === "1") return { from: addDays(today, -1), to: today };
  if (q === "7") return { from: addDays(today, -7), to: today };
  if (q === "30") return { from: addDays(today, -30), to: today };
  return {};
}

function dayHeading(ymd: string) {
  const today = nyDate();
  if (ymd === today) return commonI18n.t("time.today");
  if (ymd === addDays(today, -1)) return commonI18n.t("time.yesterday");
  return fmtDateCustom(ymd, { weekday: "short", day: "numeric", month: "long" });
}

export function AuditRow({ entry, tierNames }: { entry: AuditEntry; tierNames?: Record<string, string> }) {
  const { t: ta } = adminAuditI18n.useT();
  const t = describeAudit(entry, tierNames);
  const obj = objectLabel(entry.targetType, entry.targetId);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground" title={ta("log.timeTitle", { ny: fmtDate(entry.createdAt, "shortDateTimeSeconds", { timeZone: "America/New_York" }), local: fmtDate(entry.createdAt, "shortDateTimeSeconds") })}>
        {fmtTimeNY(entry.createdAt)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Pill tone={t.tone}>{t.label}</Pill>
          <span><span className="font-medium">{actorName(entry.actor)}</span> {t.text}</span>
        </div>
        {(t.detail || obj) && (
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {t.detail && <span className="min-w-0 max-w-full whitespace-pre-line break-words">{t.detail}</span>}
            {obj && <span className="shrink-0">{obj}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

export function AuditLog({ actor, tierNames }: { actor: string; tierNames?: Record<string, string> }) {
  const { t: ta, lang } = adminAuditI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [quick, setQuick] = useState<Quick>("30");
  const [from, setFrom] = useState<string>(() => rangeFor("30").from ?? "");
  const [to, setTo] = useState<string>(() => rangeFor("30").to ?? "");
  const [who, setWho] = useState(ALL);
  const [what, setWhat] = useState(ALL);
  const [objType, setObjType] = useState(ALL);
  const [objIdInput, setObjIdInput] = useState("");
  const [objId, setObjId] = useState("");

  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setObjId(objIdInput.trim()); }, 300);
    return () => clearTimeout(t);
  }, [qInput, objIdInput]);

  const pickQuick = (v: Quick) => {
    setQuick(v);
    const r = rangeFor(v);
    setFrom(r.from ?? "");
    setTo(r.to ?? "");
  };

  const query: AuditQuery = {
    actor: who === ALL ? undefined : who,
    action: what === ALL ? undefined : what,
    targetType: objType === ALL ? undefined : objType,
    targetId: objId || undefined,
    q: q || undefined,
    from: from || undefined,
    to: to || undefined,
  };
  const { data, isLoading, isError, error, refetch, isFetching } = useAuditSearch(actor, query);
  const entries = data?.items ?? [];

  const actors = useMemo(() => {
    const v = new Set((data?.facets.actors ?? []).map((f) => f.value));
    if (who !== ALL) v.add(who);
    return [...v].sort((a, b) => actorName(a).localeCompare(actorName(b), lang));
  }, [data, who, lang]);
  const actions = useMemo(() => {
    const v = new Map<string, string>();
    for (const f of data?.facets.actions ?? []) v.set(f.value, describeAudit({ actor: "", action: f.value, targetType: null, targetId: null, details: null }).label + ` · ${f.value}`);
    if (what !== ALL && !what.endsWith(".*")) v.set(what, what);
    return [...v].sort((a, b) => a[1].localeCompare(b[1], lang));
  }, [data, what, lang]);
  const objTypes = useMemo(() => {
    const v = new Set((data?.facets.targetTypes ?? []).map((f) => f.value));
    if (objType !== ALL) v.add(objType);
    return [...v].map((x) => [x, objectTypeLabel(x)] as const).sort((a, b) => a[1].localeCompare(b[1], lang));
  }, [data, objType, lang]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: AuditEntry[] }[] = [];
    for (const e of entries) {
      const key = nyDayOf(e.createdAt);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(e);
      else out.push({ key, label: dayHeading(key), items: [e] });
    }
    return out;
  }, [entries]);

  const filtersActive = !!q || who !== ALL || what !== ALL || objType !== ALL || !!objId || quick !== "30";
  const reset = () => { setQInput(""); setQ(""); setWho(ALL); setWhat(ALL); setObjType(ALL); setObjIdInput(""); setObjId(""); pickQuick("30"); };

  const exportCsv = () => downloadCsv(
    (["time", "who", "what", "details", "object", "action", "targetType", "targetId", "raw"] as const).map((k) => ta(`log.csv.${k}`)),
    entries.map((e) => {
      const t = describeAudit(e, tierNames);
      return [fmtDate(e.createdAt, "shortDateTimeSeconds"), actorName(e.actor), auditSentence(e, tierNames), t.detail ?? "", objectLabel(e.targetType, e.targetId), e.action, e.targetType ?? "", e.targetId ?? "", e.details ?? ""];
    }),
    `audit-${nyDate()}.csv`,
  );

  return (
    <Panel
      title={ta("log.title")}
      description={ta("log.description")}
      icon={ScrollText}
      actions={<Button variant="outline" size="sm" onClick={exportCsv} disabled={!entries.length}><Download /> CSV</Button>}
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.35fr)]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setQInput(""); }}
              placeholder={ta("log.searchPlaceholder")}
              aria-label={ta("log.searchAria")}
              className="pl-9"
            />
          </div>
          <Select value={who} onValueChange={setWho}>
            <SelectTrigger aria-label={ta("log.who")}><SelectValue placeholder={ta("log.whoAll")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{ta("log.whoAll")}</SelectItem>
              {actors.map((a) => <SelectItem key={a} value={a}>{actorName(a)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={what} onValueChange={setWhat}>
            <SelectTrigger aria-label={ta("log.what")}><SelectValue placeholder={ta("log.whatAll")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{ta("log.whatAll")}</SelectItem>
              {ACTION_GROUPS.map((g) => <SelectItem key={g} value={`${g}.*`}>{ta(`log.groups.${g}`)}</SelectItem>)}
              {actions.map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Select value={objType} onValueChange={setObjType}>
              <SelectTrigger aria-label={ta("log.object")} className="min-w-0 flex-1"><SelectValue placeholder={ta("log.objectAny")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{ta("log.objectAny")}</SelectItem>
                {objTypes.map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input value={objIdInput} onChange={(e) => setObjIdInput(e.target.value)} placeholder={ta("log.objectId")} aria-label={ta("log.objectIdAria")} className="w-28" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Quick>
            ariaLabel={ta("log.period")}
            size="sm"
            value={quick}
            onChange={pickQuick}
            options={[{ value: "1", label: ta("log.quick.day") }, { value: "7", label: ta("log.quick.week") }, { value: "30", label: ta("log.quick.month") }, { value: "all", label: ta("log.quick.all") }, { value: "custom", label: ta("log.quick.custom") }]}
          />
          {quick === "custom" && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              {ta("log.from")} <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label={ta("log.fromAria")} className="h-8 w-[150px]" />
              {ta("log.to")} <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label={ta("log.toAria")} className="h-8 w-[150px]" />
            </span>
          )}
          {filtersActive && <Button variant="ghost" size="sm" onClick={reset}>{tc("actions.reset")}</Button>}
          {data && (
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {data.total > entries.length ? ta("log.shown", { shown: entries.length, total: data.total }) : tc("units.entries", { count: entries.length })}
            </span>
          )}
        </div>

        {isError ? (
          <QueryError error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <ListSkeleton rows={6} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={filtersActive ? ta("log.empty.filtered") : ta("log.empty.none")}
            description={filtersActive ? ta("log.empty.filteredHint") : ta("log.empty.noneHint")}
            action={filtersActive ? <Button variant="outline" size="sm" onClick={reset}>{tc("actions.resetFilters")}</Button> : undefined}
          />
        ) : (
          <div className={isFetching ? "opacity-70 transition-opacity" : "transition-opacity"}>
            {groups.map((g) => (
              <section key={g.key} className="mb-2">
                <h3 className="micro-label sticky-top py-1.5">{g.label}</h3>
                <ul className="divide-y divide-border/50">
                  {g.items.map((e) => <AuditRow key={e.id} entry={e} tierNames={tierNames} />)}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
