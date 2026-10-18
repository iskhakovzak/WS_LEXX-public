import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, Copy, RefreshCw, AlertTriangle, Wrench, Ban, HelpCircle, CheckCircle2, FileText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { http, ApiError } from "@/lib/api/http";
import { cn } from "@/lib/utils";
import { Pill, toneText, type Tone } from "@/components/ds";
import { IconAction, InlineMd, lsGet, lsSet } from "@/components/playbook-sub/bits";
import { commonI18n } from "@/i18n/ns/common";
import { playbookToolsI18n } from "@/i18n/ns/playbookTools";
import { getLang } from "@/i18n";
import { fmtRelative } from "@/lib/format";

type Critique = { critique: string; tradesAnalyzed: number; at: number };

type Block = { kind: "p" | "ul" | "ol"; items: string[] };
type Section = { title: string | null; blocks: Block[] };

const HEADING_RES: RegExp[] = [
  /^#{1,6}\s+(.+?)\s*#*$/,
  /^\*\*([^*]{2,80}?)\*\*:?\s*$/,
  /^\d+[.)]\s+\*\*([^*]{2,80}?)\*\*:?\s*$/,
  /^([A-ZА-ЯЁ][^:.!?]{2,60}):\s*$/, // i18n-ignore (parses AI output)
];

/** Split free-form AI markdown into titled sections with paragraphs and lists. */
function parseCritique(text: string): Section[] {
  const sections: Section[] = [];
  let cur: Section = { title: null, blocks: [] };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) { cur.blocks.push({ kind: "p", items: [para.join(" ")] }); para = []; }
  };
  const pushItem = (kind: "ul" | "ol", t: string) => {
    flushPara();
    const last = cur.blocks[cur.blocks.length - 1];
    if (last && last.kind === kind) last.items.push(t);
    else cur.blocks.push({ kind, items: [t] });
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^[-*_]{3,}$/.test(line)) { flushPara(); continue; }
    const h = HEADING_RES.map((re) => line.match(re)).find(Boolean);
    if (h) {
      flushPara();
      if (cur.title || cur.blocks.length) sections.push(cur);
      cur = { title: h[1].replace(/\*\*/g, "").trim(), blocks: [] };
      continue;
    }
    const ul = line.match(/^[-*•–]\s+(.*)$/);
    if (ul) { pushItem("ul", ul[1]); continue; }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { pushItem("ol", ol[1]); continue; }
    // Continuation of a list item (indented in source).
    const last = cur.blocks[cur.blocks.length - 1];
    if (/^\s{2,}/.test(raw) && last && last.kind !== "p" && !para.length) {
      last.items[last.items.length - 1] += ` ${line}`;
      continue;
    }
    para.push(line);
  }
  flushPara();
  if (cur.title || cur.blocks.length) sections.push(cur);
  return sections;
}

function sectionStyle(title: string | null): { tone: Tone; icon: LucideIcon; highlight?: boolean } {
  const t = (title ?? "").toLowerCase();
  // Section headings of the AI answer (RU / EN / UZ) — input parsing, not UI text.
  if (/правк|рекоменд|измен|исправ|предлаг|edit|recommend|fix|action|что сделать|действ|tavsiya|tuzat|oʻzgart|o'zgart/.test(t)) return { tone: "accent", icon: Wrench, highlight: true }; // i18n-ignore (parses AI output)
  if (/противореч|ошибк|проблем|слаб|риск|contradict|problem|weak|risk|ziddiyat|xato|muammo|zaif/.test(t)) return { tone: "down", icon: Ban }; // i18n-ignore (parses AI output)
  if (/недостающ|пропущ|не хватает|размыт|расплывч|vague|missing|unclear|неясн|yetishmay|noaniq/.test(t)) return { tone: "warn", icon: HelpCircle }; // i18n-ignore (parses AI output)
  if (/работает|сильн|плюс|хорош|strength|works|kuchli|ishlaydi/.test(t)) return { tone: "up", icon: CheckCircle2 }; // i18n-ignore (parses AI output)
  return { tone: "neutral", icon: FileText };
}

/** The cached AI text is in the language it was requested in — the key includes the UI language. */
function cacheKey(id: number, userKey: string | null) {
  return `pb-critique:${id}:${userKey ?? "all"}:${getLang()}`;
}

export function PlaybookAICritiqueButton({ playbookId, playbookName }: { playbookId: number; playbookName?: string }) {
  const { t } = playbookToolsI18n.useT();
  const { user } = useAuth();
  const { toast } = useToast();
  const userKey = user?.role === "trader" && user.traderName ? user.traderName : null;
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Critique | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      try {
        return await http.post<{ critique: string; tradesAnalyzed: number }>(`/api/playbook/${playbookId}/ai-critique`, undefined, { query: { userKey } });
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          const mins = Math.max(1, Math.ceil(Number(e.field("retryAfterMs") ?? 0) / 60000));
          throw new ApiError({ status: 429, code: e.code, message: playbookToolsI18n.t("critique.rateLimited", { count: mins }), method: e.method, url: e.url });
        }
        throw e;
      }
    },
    onMutate: () => setError(null),
    onSuccess: (d) => {
      const c: Critique = { critique: String(d?.critique ?? ""), tradesAnalyzed: Number(d?.tradesAnalyzed ?? 0), at: Date.now() };
      setResult(c);
      lsSet(cacheKey(playbookId, userKey), c);
    },
    onError: (e: any) => {
      let msg = String((e instanceof ApiError && e.field<string>("detail")) || (e?.message ?? ""));
      try { const j = JSON.parse(msg); msg = j?.detail ?? j?.error ?? msg; } catch { /* plain text */ }
      setError(msg.slice(0, 300) || t("critique.unknownError"));
      toast({ title: t("critique.failed"), description: msg.slice(0, 200) || undefined, variant: "destructive" });
    },
  });

  // Opening the dialog never calls the AI by itself: a cached critique is shown, otherwise the user
  // starts it explicitly (each run costs an AI call and is rate-limited per setup).
  function openDialog() {
    const cached = lsGet<Critique | null>(cacheKey(playbookId, userKey), null);
    setOpen(true);
    if (cached?.critique) { setResult(cached); setError(null); }
  }

  const sections = useMemo(() => (result ? parseCritique(result.critique) : []), [result]);

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.critique);
      toast({ title: t("critique.copied") });
    } catch {
      toast({ title: t("critique.copyFailed"), variant: "destructive" });
    }
  }

  const n = result?.tradesAnalyzed ?? 0;

  return (
    <>
      <IconAction
        aria-label={t("critique.title")}
        title={mut.isPending ? t("critique.running") : t("critique.title")}
        onClick={(e) => { e.stopPropagation(); openDialog(); }}
        aria-busy={mut.isPending}
        className="hover:text-[hsl(var(--chart-5))]"
      >
        <Sparkles className={cn(mut.isPending && "motion-safe:animate-pulse text-[hsl(var(--chart-5))]")} aria-hidden="true" />
      </IconAction>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-4 p-4 sm:p-6">
          <DialogHeader className="pr-10">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <Sparkles className="h-4 w-4 text-[hsl(var(--chart-5))]" aria-hidden="true" />
              {t("critique.title")}
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2 text-xs">
              {playbookName && <span className="truncate font-medium text-foreground">{playbookName}</span>}
              {result && (
                <>
                  <Pill tone={n < 5 ? "warn" : "neutral"}>
                    {t("critique.tradesInAnalysis", { count: n })}
                  </Pill>
                  <span>{t("critique.updated", { time: fmtRelative(result.at) })}</span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" aria-live="polite" aria-busy={mut.isPending}>
            {mut.isPending ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">{t("critique.waiting")}</p>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="space-y-2 rounded-xl border border-[var(--glass-border)] p-3">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-5/6" />
                  </div>
                ))}
              </div>
            ) : error && !result ? (
              <div className="flex items-start gap-2 rounded-xl border border-down/30 bg-down/10 p-3 text-sm text-down" role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            ) : !result ? (
              <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-[var(--field-border)] p-4 text-sm text-muted-foreground">
                <p>{t("critique.intro")}</p>
                <p className="text-xs">{t("critique.introLimit")}</p>
              </div>
            ) : result ? (
              <>
                {n < 5 && (
                  <div className="flex items-start gap-2 rounded-xl border border-[hsl(var(--chart-3)/0.3)] bg-[hsl(var(--chart-3)/0.1)] p-3 text-xs text-[hsl(var(--chart-3))]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {n === 0
                      ? t("critique.noTrades")
                      : t("critique.fewTrades")}
                  </div>
                )}
                {sections.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("critique.empty")}</p>
                ) : sections.map((s, i) => {
                  const st = sectionStyle(s.title);
                  const Icon = st.icon;
                  return (
                    <section
                      key={i}
                      className={cn(
                        "rounded-xl border p-3",
                        st.highlight ? "border-primary/30 bg-primary/5" : "border-[var(--glass-border)] bg-[var(--glass-bg)]",
                      )}
                    >
                      {s.title && (
                        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                          <Icon className={cn("h-4 w-4 shrink-0", st.tone === "neutral" ? "text-muted-foreground" : toneText(st.tone))} aria-hidden="true" />
                          {s.title}
                        </h3>
                      )}
                      <div className="space-y-2 text-sm leading-relaxed text-foreground/90">
                        {s.blocks.map((b, j) =>
                          b.kind === "p" ? (
                            <p key={j}><InlineMd text={b.items[0]} /></p>
                          ) : b.kind === "ul" ? (
                            <ul key={j} className="space-y-1.5">
                              {b.items.map((it, k) => (
                                <li key={k} className="flex gap-2">
                                  <span className={cn("mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-current", st.tone === "neutral" ? "text-muted-foreground" : toneText(st.tone))} aria-hidden="true" />
                                  <span className="min-w-0"><InlineMd text={it} /></span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <ol key={j} className="space-y-1.5">
                              {b.items.map((it, k) => (
                                <li key={k} className="flex gap-2">
                                  <span className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums", st.highlight ? "bg-primary/15 text-primary" : "bg-[var(--glass-hover-bg)] text-muted-foreground")}>{k + 1}</span>
                                  <span className="min-w-0"><InlineMd text={it} /></span>
                                </li>
                              ))}
                            </ol>
                          ),
                        )}
                      </div>
                    </section>
                  );
                })}
              </>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--glass-border)] pt-3">
            {result && (
              <Button variant="ghost" size="sm" onClick={copy}>
                <Copy aria-hidden="true" /> {commonI18n.t("actions.copy")}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => mut.mutate()} disabled={mut.isPending}>
              <RefreshCw className={cn(mut.isPending && "motion-safe:animate-spin")} aria-hidden="true" />
              {result ? t("critique.refresh") : error ? commonI18n.t("actions.retry") : t("critique.start")}
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>{commonI18n.t("actions.close")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
