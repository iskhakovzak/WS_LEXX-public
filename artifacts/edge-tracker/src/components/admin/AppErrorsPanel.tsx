/**
 * Admin console → «Ошибки»: the internal error tracker (API routes/app-errors.ts, lib/errorTracking.ts).
 * Up front: status (open / resolved / all) and a search box; the source filter sits next to them as one select.
 * Details on demand: a row opens a side sheet with the stack, recent occurrences and «mark resolved».
 * `?error=<id>` in the URL (the Telegram alert links here) opens that error directly.
 */
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bug, CheckCircle2, Copy, Globe, RotateCcw, Search, Server, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState, ListSkeleton, Panel, Pill, Segmented } from "@/components/ds";
import { ErrorState, QueryState } from "@/components/ds/states";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { fmtDate, fmtRelative } from "@/i18n/format";
import { appErrorsI18n } from "@/i18n/ns/appErrors";
import { personName } from "@/i18n";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Source = "server" | "client" | "csp";
type Status = "open" | "resolved" | "all";

export type AppErrorRow = {
  id: number;
  source: Source;
  kind: string;
  message: string;
  route: string | null;
  status: number | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  lastRequestId: string | null;
  lastUserId: number | null;
  release: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
};
type ListResponse = { items: AppErrorRow[]; total: number; counts: { open: number; resolved: number; last24h: number } };
type Occurrence = { id: number; at: string; requestId: string | null; userId: number | null; userName: string | null; route: string | null; status: number | null };
type DetailResponse = { error: AppErrorRow & { stack: string | null; userAgent: string | null; alertedAt: string | null }; occurrences: Occurrence[] };

const PAGE = 50;
const KEY = "admin-app-errors";
const SOURCE_ICON: Record<Source, typeof Server> = { server: Server, client: Globe, csp: ShieldAlert };

function readErrorParam(): number | null {
  try {
    const v = new URLSearchParams(window.location.search).get("error");
    return v && /^\d+$/.test(v) ? Number(v) : null;
  } catch { return null; }
}
function writeErrorParam(id: number | null) {
  try {
    const url = new URL(window.location.href);
    if (id == null) url.searchParams.delete("error"); else url.searchParams.set("error", String(id));
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  } catch { /* ignore */ }
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function AppErrorsPanel() {
  const { t } = appErrorsI18n.useT();
  const [status, setStatus] = useState<Status>("open");
  const [source, setSource] = useState<Source | "all">("all");
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput.trim());
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<number | null>(readErrorParam);

  useEffect(() => { setLimit(PAGE); }, [status, source, q]);

  const list = useQuery({
    queryKey: [KEY, "list", { status, source, q, limit }],
    queryFn: () => http.get<ListResponse>("/api/admin/app-errors", { query: { status, source: source === "all" ? null : source, q, limit } }),
    staleTime: STALE.short,
    placeholderData: keepPreviousData,
  });

  const open = (id: number | null) => { setOpenId(id); writeErrorParam(id); };
  const filtered = status !== "open" || source !== "all" || !!q;
  const counts = list.data?.counts;

  return (
    <Panel
      title={t("title")}
      description={t("description")}
      icon={Bug}
      actions={counts && counts.last24h > 0 ? <Pill tone="down">{t("last24h", { count: counts.last24h })}</Pill> : undefined}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Status>
            ariaLabel={t("status.aria")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "open", label: counts ? `${t("status.open")} · ${counts.open}` : t("status.open") },
              { value: "resolved", label: t("status.resolved") },
              { value: "all", label: t("status.all") },
            ]}
          />
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={t("search")} aria-label={t("searchAria")} className="h-9 pl-9" maxLength={200} />
          </div>
          <Select value={source} onValueChange={(v) => setSource(v as Source | "all")}>
            <SelectTrigger className="h-9 w-auto min-w-[9rem]" aria-label={t("source.aria")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("source.all")}</SelectItem>
              <SelectItem value="server">{t("source.server")}</SelectItem>
              <SelectItem value="client">{t("source.client")}</SelectItem>
              <SelectItem value="csp">{t("source.csp")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <QueryState
          query={list}
          skeleton={<ListSkeleton rows={6} />}
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState
              icon={filtered ? Search : CheckCircle2}
              title={filtered ? t("empty.filtered") : t("empty.open")}
              description={filtered ? t("empty.filteredHint") : t("empty.openHint")}
              className="py-12"
            />
          }
        >
          {(d) => (
            <>
              <ul className={cn("divide-y divide-border/60", list.isFetching && "opacity-70 transition-opacity")}>
                {d.items.map((row) => <ErrorRow key={row.id} row={row} onOpen={() => open(row.id)} />)}
              </ul>
              {d.total > d.items.length && (
                <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
                  <span>{t("shown", { shown: d.items.length, total: d.total })}</span>
                  <Button variant="outline" size="sm" onClick={() => setLimit((l) => Math.min(l + PAGE, 200))} disabled={limit >= 200 || list.isFetching}>
                    {t("more")}
                  </Button>
                </div>
              )}
            </>
          )}
        </QueryState>
      </div>

      <ErrorDetailSheet id={openId} onClose={() => open(null)} />
    </Panel>
  );
}

function SourcePill({ source }: { source: Source }) {
  const { t } = appErrorsI18n.useT();
  const Icon = SOURCE_ICON[source];
  return (
    <Pill tone={source === "server" ? "down" : source === "client" ? "warn" : "neutral"} className="gap-1">
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(`source.${source}`)}
    </Pill>
  );
}

function ErrorRow({ row, onOpen }: { row: AppErrorRow; onOpen: () => void }) {
  const { t } = appErrorsI18n.useT();
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-3 rounded-lg px-1 py-2.5 text-left transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <SourcePill source={row.source} />
            <span className="truncate font-mono text-xs text-muted-foreground" title={row.kind}>{row.kind}</span>
            {row.resolvedAt && <Pill tone="up">{t("status.resolved")}</Pill>}
          </div>
          <p className="mt-1 line-clamp-2 break-words text-sm text-foreground" title={row.message}>{row.message}</p>
          {row.route && <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground" title={row.route}>{row.route}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-xs tabular-nums text-muted-foreground">
          <span className={cn("font-semibold", row.count > 1 ? "text-foreground" : "")}>{t("times", { count: row.count })}</span>
          <span title={fmtDate(row.lastSeen, "dateTime")}>{fmtRelative(row.lastSeen)}</span>
        </div>
      </button>
    </li>
  );
}

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words text-sm text-foreground", mono && "font-mono text-xs")}>{children}</dd>
    </div>
  );
}

function ErrorDetailSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { t } = appErrorsI18n.useT();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: [KEY, "detail", id],
    queryFn: () => http.get<DetailResponse>(`/api/admin/app-errors/${id}`),
    enabled: id != null,
    staleTime: STALE.short,
  });
  const resolve = useMutation({
    mutationFn: (resolved: boolean) => http.post<{ error: AppErrorRow }>(`/api/admin/app-errors/${id}/resolve`, { resolved }),
    onSuccess: (_r, resolved) => {
      toast({ title: resolved ? t("toast.resolved") : t("toast.reopened") });
      void qc.invalidateQueries({ queryKey: [KEY] });
    },
    onError: (err) => toast({ title: t("toast.failed"), description: humanizeApiError(err), variant: "destructive" }),
  });
  const [copied, setCopied] = useState(false);
  const e = detail.data?.error;
  const stack = e?.stack ?? null;

  const copyStack = async () => {
    if (!stack) return;
    try { await navigator.clipboard.writeText(`${e?.kind}: ${e?.message}\n${stack}`); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const meta = useMemo(() => e ? [
    { label: t("detail.firstSeen"), value: fmtDate(e.firstSeen, "dateTime") },
    { label: t("detail.lastSeen"), value: fmtDate(e.lastSeen, "dateTime") },
    { label: t("detail.count"), value: String(e.count) },
    ...(e.status ? [{ label: t("detail.status"), value: String(e.status) }] : []),
    ...(e.release ? [{ label: t("detail.release"), value: e.release, mono: true }] : []),
    ...(e.lastRequestId ? [{ label: t("detail.requestId"), value: e.lastRequestId, mono: true }] : []),
  ] : [], [e, t]);

  return (
    <Sheet open={id != null} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-5 pb-3 pt-5 text-left">
          <SheetTitle>{t("detail.title", { id: id ?? "" })}</SheetTitle>
          <SheetDescription className="line-clamp-3 break-words">{e ? `${e.kind}: ${e.message}` : " "}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {detail.isError ? (
            <ErrorState error={detail.error} onRetry={() => detail.refetch()} compact />
          ) : !e ? (
            <ListSkeleton rows={5} />
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center gap-2">
                <SourcePill source={e.source} />
                {e.resolvedAt ? (
                  <span className="text-xs text-up">{t("detail.resolvedBy", { name: e.resolvedBy ?? "—", when: fmtRelative(e.resolvedAt) })}</span>
                ) : null}
                {e.alertedAt && <span className="text-xs text-muted-foreground">{t("detail.alerted", { when: fmtRelative(e.alertedAt) })}</span>}
              </div>
              {e.route && <Field label={t("detail.route")} mono>{e.route}</Field>}
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {meta.map((m) => <Field key={m.label} label={m.label} mono={"mono" in m && !!m.mono}>{m.value}</Field>)}
              </dl>
              {e.userAgent && <Field label={t("detail.userAgent")}><span className="text-xs text-muted-foreground">{e.userAgent}</span></Field>}

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-foreground">{t("detail.stack")}</h3>
                  {stack && (
                    <Button variant="ghost" size="sm" onClick={copyStack} className="h-7 text-xs text-muted-foreground">
                      <Copy aria-hidden="true" />
                      {copied ? t("detail.copied") : t("detail.copy")}
                    </Button>
                  )}
                </div>
                {stack ? (
                  <pre className="max-h-80 overflow-auto whitespace-pre rounded-xl bg-muted/50 p-3 font-mono text-2xs leading-relaxed text-foreground">{stack}</pre>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("detail.noStack")}</p>
                )}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-foreground">{t("detail.occurrences")}</h3>
                {detail.data!.occurrences.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("detail.noOccurrences")}</p>
                ) : (
                  <ul className="divide-y divide-border/60 text-xs">
                    {detail.data!.occurrences.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                        <span className="tabular-nums text-muted-foreground" title={fmtDate(o.at, "dateTime")}>{fmtRelative(o.at)}</span>
                        {o.userName && <span className="font-medium text-foreground">{personName(o.userName)}</span>}
                        {o.status && <span className="tabular-nums text-muted-foreground">{o.status}</span>}
                        {o.requestId && <span className="truncate font-mono text-2xs text-muted-foreground" title={o.requestId}>{o.requestId}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
        {e && (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
            <Button variant="outline" onClick={onClose}>{t("detail.close")}</Button>
            {e.resolvedAt ? (
              <Button variant="outline" onClick={() => resolve.mutate(false)} disabled={resolve.isPending}>
                <RotateCcw aria-hidden="true" />
                {t("detail.reopen")}
              </Button>
            ) : (
              <Button onClick={() => resolve.mutate(true)} disabled={resolve.isPending}>
                <CheckCircle2 aria-hidden="true" />
                {t("detail.resolve")}
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
