/**
 * Legacy free-text helpers for the setup card: «Вход: … / Инвалидация: …» headings → labelled blocks (ThesisView,
 * structureConditions) and the inline editor for the legacy `conditions` / `notes` texts (InlineTextSection).
 * (The old full-page SetupDocument / EdgeStrip were unused and were removed in the i18n wave.)
 */
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, type FileText } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toneText, type Tone } from "@/components/ds";
import { IconAction } from "@/components/playbook-sub/bits";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { invalidatePlaybook } from "./api";
import { http } from "@/lib/api/http";
import { DocSection } from "./setup-bits";
import type { PlaybookEntry } from "./model";
import { commonI18n } from "@/i18n/ns/common";
import { playbookSetupI18n } from "@/i18n/ns/playbookSetup";

/* ---------- structured thesis ---------- */

type Block = { key: string; label: string; tone: Tone; lines: string[] };
type HeadingKey = "thesis" | "entry" | "invalid" | "targets" | "mgmt";
// Heading words users type, in RU / EN / UZ (input parsing, not UI text). `(?![\p{L}\p{N}])` instead of `\b`:
// `\b` is ASCII-only, so Cyrillic headings («Вход:») never matched before.
const HEADINGS: { re: RegExp; key: HeadingKey; tone: Tone }[] = [
  { re: /^(тезис|идея|контекст|почему|thesis|idea|context|why|tezis|gʻoya|g'oya|kontekst)(?![\p{L}\p{N}])/iu, key: "thesis", tone: "accent" }, // i18n-ignore (input parser)
  { re: /^(вход|триггер|условия входа|entry|trigger|kirish)(?![\p{L}\p{N}])/iu, key: "entry", tone: "up" }, // i18n-ignore (input parser)
  { re: /^(инвалидация|стоп|отмена|invalidation|stop|bekor boʻlish|bekor bo'lish|bekor)(?![\p{L}\p{N}])/iu, key: "invalid", tone: "down" }, // i18n-ignore (input parser)
  { re: /^(цел[ьи]|таргет[ыа]?|выход|тейк|targets?|exit|maqsad(?:lar)?|chiqish)(?![\p{L}\p{N}])/iu, key: "targets", tone: "warn" }, // i18n-ignore (input parser)
  { re: /^(управление|сопровождение|management|риск|risk|boshqaruv|kuzatib borish)(?![\p{L}\p{N}])/iu, key: "mgmt", tone: "purple" }, // i18n-ignore (input parser)
];

/** Splits free text into labelled blocks when it uses "Инвалидация: …", "Цели: …" style headings. */
export function structureConditions(text: string | null | undefined): Block[] | null {
  if (!text?.trim()) return null;
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let found = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[#>*\-•\s]+/, "").trimEnd();
    const m = line.match(/^([^:：]{2,28})[:：]\s*(.*)$/);
    const h = m ? HEADINGS.find((x) => x.re.test(m[1].trim())) : undefined;
    if (m && h) {
      found++;
      cur = { key: `${h.key}-${blocks.length}`, label: playbookSetupI18n.t(`heading.${h.key}`), tone: h.tone, lines: m[2] ? [m[2]] : [] };
      blocks.push(cur);
    } else if (raw.trim()) {
      if (!cur) { cur = { key: "intro", label: playbookSetupI18n.t("heading.intro"), tone: "neutral", lines: [] }; blocks.push(cur); }
      cur.lines.push(raw.trim());
    }
  }
  return found > 0 ? blocks : null;
}

const BLOCK_BAR: Record<Tone, string> = {
  up: "bg-up", down: "bg-down", accent: "bg-primary", warn: "bg-[hsl(var(--chart-3))]", purple: "bg-[hsl(var(--chart-5))]", neutral: "bg-muted-foreground/60",
};

export function ThesisView({ text }: { text: string }) {
  const blocks = structureConditions(text);
  if (!blocks) return <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{text}</p>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {blocks.map((b) => (
        <div key={b.key} className={cn("relative overflow-hidden rounded-xl bg-[var(--glass-bg)] py-2.5 pl-4 pr-3", (b.key.startsWith("intro") || b.key.startsWith("thesis")) && "sm:col-span-2")}>
          <span className={cn("absolute inset-y-2 left-1.5 w-[3px] rounded-full", BLOCK_BAR[b.tone])} aria-hidden="true" />
          <div className={cn("mb-0.5 text-xs font-medium", toneText(b.tone === "neutral" ? "neutral" : b.tone))}>{b.label}</div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{b.lines.join("\n")}</p>
        </div>
      ))}
    </div>
  );
}

/* ---------- inline editable text section ---------- */

export function InlineTextSection({
  entry, field, title, icon, placeholder, empty, render,
}: {
  entry: PlaybookEntry;
  field: "conditions" | "notes";
  title: string;
  icon: typeof FileText;
  placeholder: string;
  empty: string;
  render?: (text: string) => ReactNode;
}) {
  const { t } = playbookSetupI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { canEdit } = useAuth();
  const value = entry[field] ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const mut = useMutation({
    mutationFn: (text: string) => http.patch(`/api/playbook/${entry.id}`, { [field]: text || null }),
    onMutate: async (text) => {
      await qc.cancelQueries({ queryKey: ["playbook"] });
      const prev = qc.getQueryData<PlaybookEntry[]>(["playbook"]);
      qc.setQueryData<PlaybookEntry[]>(["playbook"], (old = []) => old.map((e) => (e.id === entry.id ? { ...e, [field]: text || null } : e)));
      setEditing(false);
      return { prev };
    },
    onError: (e: any, _t, ctx) => {
      if (ctx?.prev) qc.setQueryData(["playbook"], ctx.prev);
      setEditing(true);
      toast({ title: commonI18n.t("states.saveFailed"), description: e?.message, variant: "destructive" });
    },
    onSettled: () => invalidatePlaybook(qc, entry.id),
  });

  const save = () => { if (draft !== value) mut.mutate(draft.trim()); else setEditing(false); };

  return (
    <DocSection
      title={title}
      icon={icon}
      actions={canEdit && !editing ? <IconAction aria-label={t("inline.editTitle", { title })} title={t("inline.editTitle", { title })} onClick={() => setEditing(true)}><Pencil /></IconAction> : undefined}
    >
      {editing ? (
        <div className="space-y-2">
          <Textarea
            aria-label={title}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(14, Math.max(4, draft.split("\n").length + 1))}
            placeholder={placeholder}
            autoFocus
            className="resize-y text-sm"
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.stopPropagation(); setEditing(false); setDraft(value); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
            }}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">{t("inline.hint")}</span>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(value); }}>{commonI18n.t("actions.cancel")}</Button>
            <Button size="sm" variant="outline" onClick={save} disabled={mut.isPending}>{commonI18n.t("actions.save")}</Button>
          </div>
        </div>
      ) : value ? (
        render ? render(value) : <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{value}</p>
      ) : canEdit ? (
        <button type="button" onClick={() => setEditing(true)} className="w-full rounded-xl border border-dashed border-border px-3 py-3 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {empty}
        </button>
      ) : (
        <p className="text-sm text-muted-foreground">—</p>
      )}
    </DocSection>
  );
}
