import * as React from "react";
import type { Research } from "@workspace/api-client-react";
import { addDays, nyDate } from "@/lib/trading-date";
import { fmtDateCustom } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { researchI18n } from "@/i18n/ns/research";

/* ── Server shape: generated `Research` + additive fields from `GET /api/research` ── */
export type ResearchEvidence = {
  tradeCount: number; wins: number; losses: number; be: number;
  winRate: number | null; sumR: number | null; grossPnl: number | null; fees: number | null; netPnl: number | null;
};
export type ResearchNote = Research & {
  createdBy?: string | null;
  /** Trading day the note is about (NY date); defaults to the creation day. */
  date?: string;
  playbookId?: number | null;
  evidence?: ResearchEvidence;
  derivedConfidence?: number | null;
  confidenceSource?: "trades" | "manual";
  /** Viewer's pin (research_pins), per user — not per browser. */
  pinned?: boolean;
};

/** The day a note belongs to: the explicit `date` column, else the NY day it was created. */
export function noteDay(r: ResearchNote): string {
  return r.date && /^\d{4}-\d{2}-\d{2}/.test(r.date) ? r.date.slice(0, 10) : localDay(r.createdAt);
}

export function splitTags(tags?: string | null): string[] {
  if (!tags) return [];
  return tags.split(",").map((t) => t.trim()).filter(Boolean);
}

/** Tickers field may hold several symbols ("NVDA, META"). */
export function splitTickers(ticker?: string | null): string[] {
  if (!ticker) return [];
  return ticker
    .split(/[\s,;/]+/)
    .map((t) => t.trim().toUpperCase().replace(/^\$/, ""))
    .filter(Boolean);
}

// createdAt is a UTC ISO timestamp; the desk's calendar day is America/New_York.
export function localDay(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso.substring(0, 10) : nyDate(d);
}

export function formatDay(dateStr: string) {
  const d = new Date(dateStr + "T12:00:00");
  if (isNaN(d.getTime())) return dateStr;
  const today = nyDate();
  if (dateStr === today) return commonI18n.t("time.today");
  if (dateStr === addDays(today, -1)) return commonI18n.t("time.yesterday");
  return fmtDateCustom(d, {
    weekday: "short",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

// ── Search ──────────────────────────────────────────────────────────────
/**
 * Query syntax: plain words (AND, any field), `#tag` (tag contains), `$TICKER` (exact ticker).
 * Quotes keep phrases together: "gap and go".
 */
export type ParsedQuery = { words: string[]; tags: string[]; tickers: string[] };

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { words: [], tags: [], tickers: [] };
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw) continue;
    if (!m[1] && raw.startsWith("#") && raw.length > 1) out.tags.push(raw.slice(1).toLowerCase());
    else if (!m[1] && raw.startsWith("$") && raw.length > 1) out.tickers.push(raw.slice(1).toUpperCase());
    else out.words.push(raw.toLowerCase());
  }
  return out;
}

export function isEmptyQuery(p: ParsedQuery) {
  return !p.words.length && !p.tags.length && !p.tickers.length;
}

type SearchKey = "patternName" | "ticker" | "context" | "whatWorked" | "whatFailed" | "marketCondition" | "tags" | "longName" | "sector" | "screenshotNotes";
/** Field label in the UI language (read at call time). */
function fieldLabel(k: SearchKey): string {
  if (k === "ticker") return commonI18n.t("trading.ticker");
  if (k === "tags") return commonI18n.t("fields.tags");
  if (k === "sector") return commonI18n.t("trading.sector");
  return researchI18n.t(`field.${k}`);
}
export const SEARCH_FIELDS: { key: SearchKey; readonly label: string }[] = (
  ["patternName", "ticker", "context", "whatWorked", "whatFailed", "marketCondition", "tags", "longName", "sector", "screenshotNotes"] as const
).map((key) => ({ key, get label() { return fieldLabel(key); } }));

export type SearchHit = { score: number; snippetField?: string; snippet?: string };

/** Returns null when the note doesn't match; otherwise a score and the best text snippet. */
export function matchResearch(r: Research, p: ParsedQuery): SearchHit | null {
  if (p.tickers.length) {
    const ts = splitTickers(r.ticker);
    if (!p.tickers.every((t) => ts.includes(t))) return null;
  }
  if (p.tags.length) {
    const tags = splitTags(r.tags).map((t) => t.toLowerCase());
    if (!p.tags.every((t) => tags.some((x) => x.includes(t)))) return null;
  }
  let score = 0;
  let snippetField: string | undefined;
  let snippet: string | undefined;
  for (const w of p.words) {
    let found = false;
    for (const f of SEARCH_FIELDS) {
      const v = r[f.key];
      if (typeof v !== "string" || !v) continue;
      const idx = v.toLowerCase().indexOf(w);
      if (idx < 0) continue;
      found = true;
      score += f.key === "patternName" ? 5 : f.key === "ticker" ? 4 : f.key === "tags" ? 3 : 1;
      // Prefer a body-text snippet (title/ticker/tags are already visible on the row).
      if (!snippet && !["patternName", "ticker", "tags"].includes(f.key as string)) {
        snippetField = f.label;
        snippet = makeSnippet(v, idx, w.length);
      }
    }
    if (!found) return null;
  }
  return { score, snippetField, snippet };
}

function makeSnippet(text: string, idx: number, len: number, radius = 70) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps every occurrence of the search terms in <mark>. */
export function Highlight({ text, terms, className }: { text?: string | null; terms: string[]; className?: string }) {
  if (!text) return null;
  const ts = terms.filter((t) => t.length > 0);
  if (!ts.length) return <span className={className}>{text}</span>;
  const re = new RegExp(`(${ts.map(escapeRe).sort((a, b) => b.length - a.length).join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-primary/25 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </span>
  );
}

export function highlightTerms(p: ParsedQuery) {
  return [...p.words, ...p.tags, ...p.tickers];
}

// Pins live on the server now (`POST /api/research/:id/pin`, per user) — see ResearchNote.pinned.

export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

// ── Confidence ──────────────────────────────────────────────────────────
/** Older notes stored confidence on a 1–10 scale; the slider is 0–100 %. Bring the legacy values onto the % scale. */
export function confidencePct(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v > 0 && v <= 10 ? v * 10 : v;
}

/** The confidence a note shows: observed win rate once it has evidence (≥5 decided trades), else the manual estimate. */
export function noteConfidence(r: { confidenceLevel?: number | null; confidenceSource?: string; derivedConfidence?: number | null }): { value: number | null; byTrades: boolean } {
  const byTrades = r.confidenceSource === "trades" && r.derivedConfidence != null;
  return { value: byTrades ? Math.round(r.derivedConfidence!) : confidencePct(r.confidenceLevel), byTrades };
}

export function confidenceTone(v: number | null | undefined): "up" | "warn" | "down" | "neutral" {
  if (v == null) return "neutral";
  if (v >= 70) return "up";
  if (v >= 50) return "warn";
  return "down";
}

// ── CSV ─────────────────────────────────────────────────────────────────
export function exportResearchCsv(rows: Research[]) {
  const cols: (keyof Research)[] = [
    "id", "createdAt", "patternName", "ticker", "tags", "confidenceLevel", "repeatCount",
    "marketCondition", "context", "whatWorked", "whatFailed", "sector", "marketCap", "float", "atr", "relativeVolume",
  ];
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `research-${nyDate()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Templates for quick-add ─────────────────────────────────────────────
export type ResearchTemplate = {
  id: "earnings" | "ticker" | "pattern" | "theme";
  readonly label: string;
  readonly patternName: string;
  readonly context: string;
  marketCondition?: string;
  tags?: string;
};

/** Starter text in the UI language (getters: read when the template is applied, never frozen at import). */
export const RESEARCH_TEMPLATES: ResearchTemplate[] = [
  {
    id: "earnings",
    get label() { return researchI18n.t("tpl.earnings.label"); },
    patternName: "Earnings gap",
    get context() { return researchI18n.t("tpl.earnings.context"); },
    tags: "earnings",
  },
  {
    id: "ticker",
    get label() { return researchI18n.t("tpl.ticker.label"); },
    get patternName() { return researchI18n.t("tpl.ticker.name"); },
    get context() { return researchI18n.t("tpl.ticker.context"); },
  },
  {
    id: "pattern",
    get label() { return researchI18n.t("tpl.pattern.label"); },
    patternName: "",
    get context() { return researchI18n.t("tpl.pattern.context"); },
  },
  {
    id: "theme",
    get label() { return researchI18n.t("tpl.theme.label"); },
    get patternName() { return researchI18n.t("tpl.theme.name"); },
    get context() { return researchI18n.t("tpl.theme.context"); },
    marketCondition: "",
  },
];
