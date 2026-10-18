import JSZip from "jszip";
import { fmtDate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { playbookToolsI18n } from "@/i18n/ns/playbookTools";
import { HORIZON_LABEL, STRUCTURED, timeOfDayLabel, type StructuredKey } from "./model";

/**
 * Markdown / Notion export of the playbook. Headings follow the UI language at export time (`x` is only called
 * inside the export functions); setup names, folders, notes, checklists and card texts are user content, as is.
 */
const x = playbookToolsI18n.t;

export type ExportEntry = {
  id: number;
  name: string;
  folder: string | null;
  setupType: string | null;
  conditions: string | null;
  checklist: string | null;
  notes: string | null;
  confidenceLevel: number | null;
  screenshotUrl: string | null;
  screenshotNotes: string | null;
  tags: string | null;
  createdAt: string;
  parentId: number | null;
  ticker: string | null;
  marketCap: string | null;
  float: string | null;
  adv: string | null;
  atr: number | null;
  relativeVolume: number | null;
  beta: number | null;
  shortInterest: number | null;
  sector: string | null;
  longName: string | null;
  /* structured card (current API) */
  horizon?: string | null;
  timeOfDay?: string | null;
} & Partial<Record<StructuredKey, string | null>>;

function parseScreenshots(rawUrl: string | null, rawNotes: string | null): { url: string; note: string }[] {
  if (!rawUrl) return [];
  const urls = rawUrl.split("\n").map(u => u.trim()).filter(Boolean);
  let notes: string[] = [];
  if (rawNotes) {
    try { notes = JSON.parse(rawNotes); } catch { notes = []; }
  }
  return urls.map((url, i) => ({ url, note: notes[i] ?? "" }));
}

function renderFundamentalsTable(e: ExportEntry): string {
  const rows: [string, string][] = [];
  if (e.ticker) rows.push([x("export.ticker"), e.longName ? `${e.ticker} — ${e.longName}` : e.ticker]);
  if (e.sector) rows.push([x("export.sector"), e.sector]);
  if (e.marketCap) rows.push(["Market Cap", e.marketCap]);
  if (e.float) rows.push(["Float", e.float]);
  if (e.adv) rows.push(["ADV", e.adv]);
  if (e.atr != null) rows.push(["ATR", String(e.atr)]);
  if (e.relativeVolume != null) rows.push(["Rel. Volume", `${e.relativeVolume}x`]);
  if (e.beta != null) rows.push(["Beta", String(e.beta)]);
  if (e.shortInterest != null) rows.push(["Short Interest", `${e.shortInterest}%`]);
  if (!rows.length) return "";
  return `| ${x("export.param")} | ${x("export.value")} |\n| --- | --- |\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}\n`;
}

/** The structured card (context / trigger / entry / stop / targets …) as labelled blocks; "" when empty. */
function renderCard(e: ExportEntry, labelStyle: "bold" | "h4"): string {
  const out: string[] = [];
  const meta: string[] = [];
  if (e.horizon) meta.push(`**${x("export.horizon")}:** ${HORIZON_LABEL[e.horizon] ?? e.horizon}`);
  if (e.timeOfDay) meta.push(`**${x("export.timeOfDay")}:** ${timeOfDayLabel(e.timeOfDay)}`);
  if (meta.length) { out.push(meta.join("  \n")); out.push(""); }
  for (const f of STRUCTURED) {
    const v = (e[f.key] ?? "").trim();
    if (!v) continue;
    out.push(labelStyle === "bold" ? `**${f.label}:**` : `#### ${f.label}`);
    out.push(v);
    out.push("");
  }
  return out.join("\n");
}

function renderChecklist(raw: string | null): string {
  if (!raw?.trim()) return "";
  const items = raw.split("\n").map(l => l.trim()).filter(Boolean);
  return items.map(item => `- [ ] ${item.replace(/^[-•*]\s*/, "")}`).join("\n");
}

function renderScreenshots(rawUrl: string | null, rawNotes: string | null, embed: boolean): string {
  const shots = parseScreenshots(rawUrl, rawNotes);
  if (!shots.length) return "";
  if (embed) {
    return shots.map(s => s.note ? `![${s.note}](${s.url})\n*${s.note}*` : `![${x("export.screenshot")}](${s.url})`).join("\n\n");
  }
  return shots.map(s => s.note ? `- [${s.note}](${s.url})` : `- ${s.url}`).join("\n");
}

/** Split entries into top-level parents + children map. Children whose parent is missing
 *  (e.g. parent was deleted) are treated as top-level so they are not silently dropped. */
function splitHierarchy(entries: ExportEntry[]): { parents: ExportEntry[]; childrenMap: Map<number, ExportEntry[]> } {
  const ids = new Set(entries.map(e => e.id));
  const parents = entries.filter(e => !e.parentId || !ids.has(e.parentId));
  const childrenMap = new Map<number, ExportEntry[]>();
  for (const e of entries) {
    if (e.parentId && ids.has(e.parentId)) {
      if (!childrenMap.has(e.parentId)) childrenMap.set(e.parentId, []);
      childrenMap.get(e.parentId)!.push(e);
    }
  }
  return { parents, childrenMap };
}

/** Folder names in the user's display order (if given), then any remaining ones. */
function orderFolders(parents: ExportEntry[], folderOrder?: string[]): string[] {
  const present = Array.from(new Set(parents.map(e => e.folder).filter(Boolean))) as string[];
  if (!folderOrder?.length) return present;
  const ordered = folderOrder.filter(f => present.includes(f));
  return [...ordered, ...present.filter(f => !ordered.includes(f))];
}

function tagChips(tags: string | null): string | null {
  const chips = (tags ?? "").split(",").map(t => t.trim()).filter(Boolean);
  return chips.length ? chips.map(t => `\`${t}\``).join(" ") : null;
}

// ── Standard Markdown export (single file) ─────────────────────────────────

function renderEntryMd(e: ExportEntry, level: number): string {
  const h = "#".repeat(level);
  const lines: string[] = [];

  lines.push(`${h} ${e.name}`);
  lines.push("");

  const meta: string[] = [];
  if (e.setupType) meta.push(`**${x("export.type")}:** ${e.setupType}`);
  if (e.confidenceLevel != null) meta.push(`**${x("export.confidence")}:** ${e.confidenceLevel}%`);
  const chips = tagChips(e.tags);
  if (chips) meta.push(`**${x("export.tags")}:** ${chips}`);
  meta.push(`**${x("export.added")}:** ${fmtDate(e.createdAt, "long")}`);
  if (meta.length) { lines.push(meta.join("  \n")); lines.push(""); }

  const fund = renderFundamentalsTable(e);
  if (fund) { lines.push(fund); }

  const cardMd = renderCard(e, "bold");
  if (cardMd) lines.push(cardMd);

  if (e.conditions?.trim()) {
    lines.push(`**${x("export.conditions")}:**`);
    lines.push(e.conditions.trim());
    lines.push("");
  }

  const cl = renderChecklist(e.checklist);
  if (cl) {
    lines.push(`**${x("export.checklist")}:**`);
    lines.push(cl);
    lines.push("");
  }

  if (e.notes?.trim()) {
    lines.push(`**${x("export.notes")}:**`);
    lines.push(e.notes.trim());
    lines.push("");
  }

  const shots = renderScreenshots(e.screenshotUrl, e.screenshotNotes, false);
  if (shots) {
    lines.push(`**${x("export.screenshots")}:**`);
    lines.push(shots);
    lines.push("");
  }

  return lines.join("\n");
}

export function generatePlaybookMarkdown(entries: ExportEntry[], folderOrder?: string[]): string {
  const { parents, childrenMap } = splitHierarchy(entries);
  const folders = orderFolders(parents, folderOrder);
  const unfiled = parents.filter(e => !e.folder);
  const now = fmtDate(new Date(), "long");

  const out: string[] = [];
  out.push(`# ${x("export.title")}`);
  out.push(`> ${x("export.exportedAt", { date: now })} · ${x("export.totals", { setups: commonI18n.t("units.setups", { count: parents.length }), children: entries.length - parents.length })}`);
  out.push("");
  out.push("---");
  out.push("");

  function appendFolder(folderName: string | null, items: ExportEntry[]) {
    if (folderName) { out.push(`## 📁 ${folderName}`); out.push(""); }
    else if (folders.length > 0) { out.push(`## 📂 ${x("export.unfiled")}`); out.push(""); }
    const seen = new Set<number>();
    function appendWithChildren(e: ExportEntry, level: number) {
      if (seen.has(e.id)) return; // guard against parent cycles
      seen.add(e.id);
      out.push(renderEntryMd(e, Math.min(level, 6)));
      for (const child of childrenMap.get(e.id) || []) appendWithChildren(child, level + 1);
    }
    for (const parent of items) {
      appendWithChildren(parent, 3);
      out.push("---");
      out.push("");
    }
  }

  for (const folder of folders) appendFolder(folder, parents.filter(e => e.folder === folder));
  if (unfiled.length) appendFolder(null, unfiled);

  return out.join("\n");
}

// ── Notion ZIP export ───────────────────────────────────────────────────────

function renderEntryNotion(e: ExportEntry, level: number, childrenMap: Map<number, ExportEntry[]>, seen: Set<number> = new Set()): string {
  seen.add(e.id);
  const h = "#".repeat(Math.min(level, 6));
  const lines: string[] = [];

  lines.push(`${h} ${e.name}`);
  lines.push("");

  // Meta block
  const meta: string[] = [];
  if (e.setupType) meta.push(`**${x("export.setupType")}:** ${e.setupType}`);
  if (e.confidenceLevel != null) meta.push(`**${x("export.confidence")}:** ${e.confidenceLevel}%`);
  if (e.ticker) meta.push(`**${x("export.ticker")}:** ${e.longName ? `${e.ticker} — ${e.longName}` : e.ticker}`);
  if (e.sector) meta.push(`**${x("export.sector")}:** ${e.sector}`);
  const chips = tagChips(e.tags);
  if (chips) meta.push(`**${x("export.tags")}:** ${chips}`);
  meta.push(`**${x("export.added")}:** ${fmtDate(e.createdAt, "long")}`);
  if (meta.length) { lines.push(meta.join("  \n")); lines.push(""); }

  // Fundamentals table
  const fund = renderFundamentalsTable(e);
  if (fund) { lines.push(`### 📊 ${x("export.fundamentals")}`); lines.push(""); lines.push(fund); }

  // Structured card
  const cardMd = renderCard(e, "h4");
  if (cardMd) { lines.push(`### 🎯 ${x("export.card")}`); lines.push(""); lines.push(cardMd); }

  // Conditions (legacy free text)
  if (e.conditions?.trim()) {
    lines.push(`### 📋 ${x("export.conditions")}`);
    lines.push("");
    lines.push(e.conditions.trim());
    lines.push("");
  }

  // Checklist
  const cl = renderChecklist(e.checklist);
  if (cl) {
    lines.push(`### ✅ ${x("export.checklist")}`);
    lines.push("");
    lines.push(cl);
    lines.push("");
  }

  // Notes
  if (e.notes?.trim()) {
    lines.push(`### 💡 ${x("export.notes")}`);
    lines.push("");
    lines.push(e.notes.trim());
    lines.push("");
  }

  // Screenshots — embedded as images for Notion
  const shots = parseScreenshots(e.screenshotUrl, e.screenshotNotes);
  if (shots.length) {
    lines.push(`### 🖼 ${x("export.screenshots")}`);
    lines.push("");
    for (const { url, note } of shots) {
      lines.push(`![${note || x("export.screenshot")}](${url})`);
      if (note) lines.push(`*${note}*`);
      lines.push("");
    }
  }

  // Children inline (within same page)
  const children = childrenMap.get(e.id) || [];
  if (children.length) {
    lines.push("---");
    lines.push("");
    for (const child of children) {
      if (seen.has(child.id)) continue; // guard against parent cycles
      lines.push(renderEntryNotion(child, level + 1, childrenMap, seen));
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

export async function generateNotionZip(entries: ExportEntry[], folderOrder?: string[]): Promise<Blob> {
  const zip = new JSZip();
  const { parents, childrenMap } = splitHierarchy(entries);
  const folders = orderFolders(parents, folderOrder);
  const unfiled = parents.filter(e => !e.folder);
  const now = fmtDate(new Date(), "long");
  const totalChildren = entries.length - parents.length;
  const unfiledName = x("export.unfiled");

  // Index page
  const indexLines: string[] = [];
  indexLines.push(`# ${x("export.title")}`);
  indexLines.push("");
  indexLines.push(`> ${x("export.exportedAt", { date: now })}`);
  indexLines.push(`> ${x("export.totalsNotion", { folders: folders.length, setups: parents.length, children: totalChildren })}`);
  indexLines.push("");
  indexLines.push(`## ${x("export.folders")}`);
  indexLines.push("");
  for (const f of folders) {
    const count = parents.filter(e => e.folder === f).length;
    const childCount = parents.filter(e => e.folder === f).reduce((acc, p) => acc + (childrenMap.get(p.id)?.length ?? 0), 0);
    const setups = commonI18n.t("units.setups", { count });
    indexLines.push(`- **${f}** — ${childCount ? x("export.folderLineChildren", { setups, children: childCount }) : x("export.folderLine", { setups })}`);
  }
  if (unfiled.length) {
    indexLines.push(`- **${unfiledName}** — ${commonI18n.t("units.setups", { count: unfiled.length })}`);
  }
  zip.file("Playbook.md", indexLines.join("\n"));

  // One .md file per folder
  function buildFolderPage(folderName: string | null, items: ExportEntry[]): string {
    const title = folderName ? `📁 ${folderName}` : `📂 ${unfiledName}`;
    const lines: string[] = [];
    lines.push(`# ${title}`);
    lines.push("");
    const children = items.reduce((acc, p) => acc + (childrenMap.get(p.id)?.length ?? 0), 0);
    lines.push(`*${x("export.folderPageMeta", { setups: commonI18n.t("units.setups", { count: items.length }), children })}*`);
    lines.push("");
    lines.push("---");
    lines.push("");
    for (const parent of items) {
      lines.push(renderEntryNotion(parent, 2, childrenMap));
      lines.push("---");
      lines.push("");
    }
    return lines.join("\n");
  }

  // Unique file names (case-insensitive): a folder named "Playbook" or two folders differing only
  // by "/" vs ":" must not overwrite each other or the index page.
  const usedNames = new Set<string>(["playbook"]);
  function uniqueName(base: string): string {
    const root = base.trim() || x("export.folderFile");
    let name = root;
    let i = 2;
    while (usedNames.has(name.toLowerCase())) name = `${root} (${i++})`;
    usedNames.add(name.toLowerCase());
    return `${name}.md`;
  }
  for (const folder of folders) {
    const items = parents.filter(e => e.folder === folder);
    const safe = folder.replace(/[/\\:*?"<>|]/g, "_");
    zip.file(uniqueName(safe), buildFolderPage(folder, items));
  }
  if (unfiled.length) {
    zip.file(uniqueName(unfiledName), buildFolderPage(null, unfiled));
  }

  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

// ── Download helpers ────────────────────────────────────────────────────────

export function downloadMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  triggerDownload(blob, filename);
}

export function downloadBlob(blob: Blob, filename: string) {
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
