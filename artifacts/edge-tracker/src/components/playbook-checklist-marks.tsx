import { useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Users, User as UserIcon, RotateCcw } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Pill, toneText } from "@/components/ds";
import { Ring, Bar, readinessTone } from "@/components/playbook-sub/bits";
import { playbookToolsI18n } from "@/i18n/ns/playbookTools";

import { personName } from "@/i18n";
export type ChecklistItem = { id: string; text: string };

function itemIdFromText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return `t${(h >>> 0).toString(36)}`;
}

export function deriveChecklistItems(items: ChecklistItem[] | null | undefined, text: string | null | undefined): ChecklistItem[] {
  if (Array.isArray(items) && items.length > 0) return items;
  if (!text) return [];
  return text.split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean)
    .map((t) => ({ id: itemIdFromText(t), text: t }));
}

type MarksData = { shared: Record<string, boolean>; personal: Record<string, boolean> };

async function fetchMarks(playbookId: number): Promise<MarksData> {
  const j = await http.get<Partial<MarksData> | null>(`/api/playbook/${playbookId}/marks`, { credentials: "include" });
  return { shared: j?.shared ?? {}, personal: j?.personal ?? {} };
}

function readinessLabel(pct: number) {
  const t = playbookToolsI18n.t;
  if (pct >= 100) return t("marks.readiness.all");
  if (pct >= 80) return t("marks.readiness.almost");
  if (pct >= 50) return t("marks.readiness.part");
  if (pct > 0) return t("marks.readiness.most");
  return t("marks.readiness.none");
}

/** Checkbox visual: 20px rounded box inside a 32px hit target. */
function Box({ on, tone }: { on: boolean; tone: "up" | "accent" }) {
  return (
    <span
      className={cn(
        "grid h-5 w-5 place-items-center rounded-md border transition-colors",
        on
          ? tone === "up" ? "border-up bg-up/20 text-up" : "border-primary bg-primary/20 text-primary"
          : "border-[var(--field-border)] bg-[var(--glass-bg)] group-hover/cb:border-foreground/40",
      )}
    >
      {on && <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />}
    </span>
  );
}

export function MarkChecklist({
  playbookId,
  items: itemsInput,
  text,
  showHints = true,
}: {
  playbookId: number;
  items?: ChecklistItem[] | null;
  text?: string | null;
  /** Show keyboard hint line under the list (desktop only). */
  showHints?: boolean;
}) {
  const { t } = playbookToolsI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const trader = user?.role === "trader" && user.traderName ? user.traderName : "";
  const items = useMemo(() => deriveChecklistItems(itemsInput, text), [itemsInput, text]);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const { data: marks, isLoading } = useQuery<MarksData>({
    queryKey: ["playbook-marks", playbookId, trader],
    queryFn: () => fetchMarks(playbookId),
    enabled: items.length > 0,
  });

  const mutate = useMutation({
    mutationFn: async (vars: { itemId: string; scope: "shared" | "personal"; done: boolean }) => {
      await http.put(`/api/playbook/${playbookId}/marks/${encodeURIComponent(vars.itemId)}`, { scope: vars.scope, done: vars.done }, { credentials: "include" });
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["playbook-marks", playbookId, trader] });
      const prev = qc.getQueryData<MarksData>(["playbook-marks", playbookId, trader]);
      qc.setQueryData<MarksData>(["playbook-marks", playbookId, trader], (cur) => {
        const base = cur ?? { shared: {}, personal: {} };
        const next = { shared: { ...base.shared }, personal: { ...base.personal } };
        next[vars.scope][vars.itemId] = vars.done;
        return next;
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["playbook-marks", playbookId, trader], ctx.prev);
      toast({ title: t("marks.saveFailed"), variant: "destructive" });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["playbook-marks", playbookId, trader] }),
  });

  if (items.length === 0) return null;

  const sharedChecked = items.filter((it) => marks?.shared?.[it.id]).length;
  const personalChecked = items.filter((it) => marks?.personal?.[it.id]).length;
  const total = items.length;
  const pct = Math.round((sharedChecked / total) * 100);
  const personalPct = Math.round((personalChecked / total) * 100);
  const tone = readinessTone(pct);
  const nextIdx = items.findIndex((it) => !marks?.shared?.[it.id]);

  function toggle(it: ChecklistItem, scope: "shared" | "personal") {
    const on = !!marks?.[scope]?.[it.id];
    mutate.mutate({ itemId: it.id, scope, done: !on });
  }

  function resetPersonal() {
    for (const it of items) if (marks?.personal?.[it.id]) mutate.mutate({ itemId: it.id, scope: "personal", done: false });
  }

  function onRowKey(e: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    const it = items[idx];
    let target: number | null = null;
    if (e.key === "ArrowDown" || e.key === "j") target = Math.min(items.length - 1, idx + 1);
    else if (e.key === "ArrowUp" || e.key === "k") target = Math.max(0, idx - 1);
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = items.length - 1;
    // i18n-ignore (RU keyboard layout keys)
    else if (trader && (e.key === "p" || e.key === "P" || e.key === "з" || e.key === "З")) {
      e.preventDefault();
      toggle(it, "personal");
      return;
    }
    if (target != null) {
      e.preventDefault();
      rowRefs.current[target]?.focus();
    }
  }

  return (
    <div className="space-y-3">
      {/* Readiness summary */}
      <div className="flex items-center gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-3">
        <Ring value={sharedChecked / total} size={44} stroke={4} tone={tone} label={t("marks.readinessPct", { pct })}>
          <span className={cn("text-xs font-semibold tabular-nums", toneText(tone))}>{pct}</span>
        </Ring>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Users className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              {t("marks.readinessTitle")}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">{sharedChecked}/{total}</span>
          </div>
          <p className="truncate text-xs text-muted-foreground" aria-live="polite">{isLoading ? t("marks.loading") : readinessLabel(pct)}</p>
          {trader && (
            <div className="flex items-center gap-2 pt-0.5">
              <UserIcon className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
              <Bar value={personalChecked / total} tone="accent" className="h-1" />
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("marks.minePct", { pct: personalPct })}</span>
              {personalChecked > 0 && (
                <button
                  type="button"
                  onClick={resetPersonal}
                  className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t("marks.resetMine")}
                  title={t("marks.resetMine")}
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" /> {t("marks.reset")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {trader && (
        <div className="flex items-center gap-3 px-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-up" aria-hidden="true" /> {t("marks.legendShared")}</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-primary" aria-hidden="true" /> {t("marks.legendPersonal")}</span>
        </div>
      )}

      <ul className="space-y-0.5" aria-label={t("marks.itemsAria")}>
        {items.map((it, idx) => {
          const sharedOn = !!marks?.shared?.[it.id];
          const personalOn = !!marks?.personal?.[it.id];
          const isNext = idx === nextIdx;
          return (
            <li
              key={it.id}
              className={cn(
                "group flex items-start gap-1 rounded-xl px-1 py-0.5 transition-colors hover:bg-[var(--glass-hover-bg)]",
                isNext && "bg-primary/5",
              )}
            >
              <button
                ref={(el) => { rowRefs.current[idx] = el; }}
                type="button"
                role="checkbox"
                aria-checked={sharedOn}
                aria-label={t("marks.sharedAria", { text: it.text })}
                title={t("marks.sharedTitle")}
                onClick={() => toggle(it, "shared")}
                onKeyDown={(e) => onRowKey(e, idx)}
                className="group/cb grid h-8 w-8 shrink-0 place-items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Box on={sharedOn} tone="up" />
              </button>
              {trader && (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={personalOn}
                  aria-label={t("marks.personalAria", { text: it.text })}
                  title={t("marks.personalTitle", { name: personName(trader) })}
                  onClick={() => toggle(it, "personal")}
                  className="group/cb grid h-8 w-8 shrink-0 place-items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Box on={personalOn} tone="accent" />
                </button>
              )}
              <span
                onClick={() => toggle(it, "shared")}
                className={cn(
                  "flex-1 cursor-pointer select-none py-1.5 text-sm leading-snug transition-colors",
                  sharedOn ? "text-muted-foreground line-through decoration-up/50" : "text-foreground",
                )}
              >
                <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{idx + 1}.</span>
                {it.text}
              </span>
              {isNext && sharedChecked > 0 && (
                <Pill tone="accent" className="mt-1.5 hidden sm:inline-flex">{t("marks.next")}</Pill>
              )}
            </li>
          );
        })}
      </ul>

      {showHints && (
        <p className="hidden px-1 text-xs text-muted-foreground sm:block">
          {trader ? t("marks.hintsPersonal") : t("marks.hints")}
        </p>
      )}
    </div>
  );
}

export function ChecklistProbabilityBadge({
  playbookId,
  items: itemsInput,
  text,
}: {
  playbookId: number;
  items?: ChecklistItem[] | null;
  text?: string | null;
}) {
  const { t } = playbookToolsI18n.useT();
  const { user } = useAuth();
  const trader = user?.role === "trader" && user.traderName ? user.traderName : "";
  const items = useMemo(() => deriveChecklistItems(itemsInput, text), [itemsInput, text]);

  const { data: marks } = useQuery<MarksData>({
    queryKey: ["playbook-marks", playbookId, trader],
    queryFn: () => fetchMarks(playbookId),
    enabled: items.length > 0,
  });

  if (items.length === 0) return null;

  const sharedChecked = items.filter((it) => marks?.shared?.[it.id]).length;
  const pct = Math.round((sharedChecked / items.length) * 100);
  const tone = readinessTone(pct);

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--field-border)] bg-[var(--glass-bg)] py-0.5 pl-0.5 pr-2"
      title={t("marks.badgeTitle", { checked: sharedChecked, total: items.length })}
    >
      <Ring value={sharedChecked / items.length} size={18} stroke={3} tone={tone} />
      <span className={cn("text-xs font-medium tabular-nums", tone === "neutral" ? "text-muted-foreground" : toneText(tone))}>
        {sharedChecked}/{items.length}
      </span>
      <span className="sr-only">{t("marks.badgeSr")}</span>
    </span>
  );
}
