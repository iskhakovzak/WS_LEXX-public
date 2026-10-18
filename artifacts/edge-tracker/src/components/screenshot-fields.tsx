import React, { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { safeHttpUrl } from "@/lib/url";
import { cn } from "@/lib/utils";
import {
  Camera, Plus, X, ExternalLink, StickyNote, Pencil, Check, ChevronLeft, ChevronRight,
  ZoomIn, ZoomOut, Maximize2, Minimize2, RotateCcw, Trash2, ImageOff, Link2, MoveLeft, MoveRight, ImagePlus,
} from "lucide-react";
import { commonI18n } from "@/i18n/ns/common";
import { screenshotsI18n } from "@/i18n/ns/screenshots";

const st = screenshotsI18n.t; // called at render / call time only
const altOf = (n: number, note?: string) => (note ? st("altNote", { n, note }) : st("alt", { n }));

interface ScreenshotFieldsProps {
  urls: string[];
  onChange: (urls: string[]) => void;
  notes?: string[];
  onNotesChange?: (notes: string[]) => void;
  /** Optional: custom section label (default: «Скриншоты» in the UI language). */
  label?: string;
  /** Optional: hide the section label (when the parent renders its own). */
  hideLabel?: boolean;
  /** Optional: maximum number of screenshots (default unlimited). */
  max?: number;
}

export function screenshotUrlsToString(urls: string[]): string {
  return urls.filter(Boolean).join("\n");
}

export function stringToScreenshotUrls(s: string | null | undefined): string[] {
  if (!s) return [""];
  const parsed = s.split("\n").map((u) => u.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : [""];
}

export function screenshotNotesToString(notes: string[]): string {
  return JSON.stringify(notes);
}

export function stringToScreenshotNotes(s: string | null | undefined, count: number): string[] {
  if (!s) return Array(count).fill("");
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      while (parsed.length < count) parsed.push("");
      return parsed.slice(0, count).map((n: unknown) => typeof n === "string" ? n : "");
    }
  } catch {}
  const legacy = s.split("\n");
  while (legacy.length < count) legacy.push("");
  return legacy.slice(0, count);
}

/** Pull every http(s) link out of free text (paste of several links, uri-list from a drag, HTML <img src>). */
function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const out: string[] = [];
  for (const raw of found) {
    const safe = safeHttpUrl(raw.replace(/[),.;]+$/, ""));
    if (safe && !out.includes(safe)) out.push(safe);
  }
  return out;
}

function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/* ───────────────────────── Editor (forms) ───────────────────────── */

function ShotTile({
  url, index, total, note, onRemove, onMove, onOpen, onNote,
}: {
  url: string;
  index: number;
  total: number;
  note: string;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onOpen: () => void;
  onNote?: (v: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <div className="group relative aspect-video overflow-hidden rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)]">
        {failed ? (
          <button
            type="button"
            onClick={onOpen}
            className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center text-muted-foreground"
            aria-label={st("open", { n: index + 1 })}
          >
            <ImageOff className="h-5 w-5" aria-hidden="true" />
            <span className="text-2xs">{st("previewUnavailable")}</span>
            <span className="max-w-full truncate text-2xs opacity-80">{hostOf(url)}</span>
          </button>
        ) : (
          <button type="button" onClick={onOpen} className="block h-full w-full" aria-label={st("open", { n: index + 1 })}>
            <img
              src={url}
              alt={altOf(index + 1, note)}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02] motion-reduce:transform-none"
              onError={() => setFailed(true)}
            />
          </button>
        )}

        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-background/80 px-1.5 text-2xs font-medium tabular-nums text-foreground backdrop-blur">
          {index + 1}
        </span>

        {/* Actions: hover-reveal on desktop, always visible on touch */}
        {confirming ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/85 p-2 backdrop-blur-sm" role="alertdialog" aria-label={st("confirmAria")}>
            <span className="text-xs font-medium text-foreground">{st("confirmDelete")}</span>
            <div className="flex gap-1.5">
              <Button type="button" size="sm" variant="destructive" onClick={onRemove} autoFocus>
                {commonI18n.t("actions.delete")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
                {commonI18n.t("actions.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            {total > 1 && index > 0 && (
              <TileBtn label={st("moveLeft", { n: index + 1 })} onClick={() => onMove(-1)}><MoveLeft /></TileBtn>
            )}
            {total > 1 && index < total - 1 && (
              <TileBtn label={st("moveRight", { n: index + 1 })} onClick={() => onMove(1)}><MoveRight /></TileBtn>
            )}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={st("openNewTab", { n: index + 1 })}
              title={st("openNewTab", { n: index + 1 })}
              className="grid h-7 w-7 place-items-center rounded-full bg-background/80 text-foreground backdrop-blur hover:bg-background [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              <ExternalLink aria-hidden="true" />
            </a>
            <TileBtn label={st("remove", { n: index + 1 })} onClick={() => setConfirming(true)} danger><Trash2 /></TileBtn>
          </div>
        )}
      </div>
      {onNote && (
        <Input
          value={note}
          onChange={(e) => onNote(e.target.value)}
          placeholder={st("notePlaceholder")}
          aria-label={st("noteAria", { n: index + 1 })}
          className="h-8 px-3 text-xs"
        />
      )}
    </li>
  );
}

function TileBtn({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-full bg-background/80 backdrop-blur transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-3.5 [&_svg]:w-3.5",
        danger ? "text-down" : "text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function ScreenshotFields({ urls, onChange, notes, onNotesChange, label: labelProp, hideLabel, max }: ScreenshotFieldsProps) {
  const label = labelProp ?? st("label");
  // Work on the non-empty links only; notes stay aligned by index (same as persistence, which drops blanks).
  const pairs = urls
    .map((u, i) => ({ url: (u ?? "").trim(), note: notes?.[i] ?? "" }))
    .filter((p) => p.url);
  const shots = pairs.map((p) => p.url);
  const shotNotes = pairs.map((p) => p.note);

  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const inputId = React.useId();
  const full = max != null && shots.length >= max;

  function commit(nextUrls: string[], nextNotes: string[]) {
    onChange(nextUrls.length > 0 ? nextUrls : [""]);
    if (onNotesChange) onNotesChange(nextNotes.length > 0 ? nextNotes : [""]);
  }

  function addMany(list: string[]): number {
    const fresh = list.filter((u) => !shots.includes(u));
    const room = max != null ? Math.max(0, max - shots.length) : fresh.length;
    const take = fresh.slice(0, room);
    if (take.length === 0) {
      setHint(list.length > 0 ? (full && max != null ? st("maxReached", { count: max }) : st("duplicate")) : null);
      return 0;
    }
    commit([...shots, ...take], [...shotNotes, ...take.map(() => "")]);
    setHint(null);
    return take.length;
  }

  function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    const found = extractUrls(text);
    if (found.length === 0) {
      setHint(st("needUrl"));
      return;
    }
    if (addMany(found) > 0) setDraft("");
  }

  function handleTransfer(dt: DataTransfer | null, e: React.SyntheticEvent): boolean {
    if (!dt) return false;
    const text = [dt.getData("text/uri-list"), dt.getData("text/html"), dt.getData("text/plain"), dt.getData("text")]
      .filter(Boolean).join("\n");
    const found = extractUrls(text);
    if (found.length > 0) {
      e.preventDefault();
      addMany(found);
      setDraft("");
      return true;
    }
    const hasFile = Array.from(dt.items ?? []).some((it) => it.kind === "file") || (dt.files?.length ?? 0) > 0;
    if (hasFile) {
      e.preventDefault();
      setHint(st("noFiles"));
      return true;
    }
    return false;
  }

  function remove(i: number) {
    commit(shots.filter((_, k) => k !== i), shotNotes.filter((_, k) => k !== i));
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= shots.length) return;
    const u = [...shots]; const n = [...shotNotes];
    [u[i], u[j]] = [u[j], u[i]];
    [n[i], n[j]] = [n[j], n[i]];
    commit(u, n);
  }

  function setNote(i: number, v: string) {
    if (!onNotesChange) return;
    const n = [...shotNotes];
    n[i] = v;
    // Parent receives the compacted url list on every change, so keep notes aligned with it.
    onNotesChange(n);
    if (shots.length !== urls.length) onChange(shots);
  }

  return (
    <div className="flex flex-col gap-2">
      {!hideLabel && (
        <label htmlFor={inputId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
          {shots.length > 0 && <span className="tabular-nums">· {shots.length}{max != null ? `/${max}` : ""}</span>}
        </label>
      )}

      {shots.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {shots.map((u, i) => (
            <ShotTile
              key={`${u}-${i}`}
              url={u}
              index={i}
              total={shots.length}
              note={shotNotes[i] ?? ""}
              onRemove={() => remove(i)}
              onMove={(d) => move(i, d)}
              onOpen={() => setLightbox(i)}
              onNote={onNotesChange ? (v) => setNote(i, v) : undefined}
            />
          ))}
        </ul>
      )}

      {!full && (
        <div
          onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { setDragOver(false); if (!handleTransfer(e.dataTransfer, e)) e.preventDefault(); }}
          className={cn(
            "flex flex-col gap-2 rounded-2xl border border-dashed p-2.5 transition-colors",
            dragOver ? "border-primary bg-primary/10" : "border-[var(--field-border)] bg-[var(--glass-bg)]",
          )}
        >
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id={inputId}
                value={draft}
                onChange={(e) => { setDraft(e.target.value); if (hint) setHint(null); }}
                onPaste={(e) => { handleTransfer(e.clipboardData, e); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitDraft(); } }}
                placeholder={st("urlPlaceholder")}
                aria-label={hideLabel ? label : undefined}
                aria-describedby={hint ? `${inputId}-hint` : undefined}
                inputMode="url"
                className="h-9 pl-10 text-sm"
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={submitDraft} disabled={!draft.trim()} className="h-9 shrink-0">
              <Plus aria-hidden="true" />
              <span className="hidden sm:inline">{st("add")}</span>
              <span className="sr-only sm:hidden">{st("addAria")}</span>
            </Button>
          </div>
          <p className="flex items-center gap-1.5 px-1 text-2xs text-muted-foreground">
            <ImagePlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {dragOver ? st("dropHint") : st("pasteHint")}
          </p>
        </div>
      )}

      {hint && (
        <p id={`${inputId}-hint`} role="status" className="px-1 text-xs text-[hsl(var(--chart-3))]">{hint}</p>
      )}

      {lightbox !== null && shots[lightbox] && (
        <Lightbox urls={shots} notes={shotNotes} initialIndex={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

/* ───────────────────────── Lightbox ───────────────────────── */

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 0.5;

function LbBtn({ label, onClick, disabled, children, btnRef }: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; btnRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={btnRef}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:h-[18px] [&_svg]:w-[18px]"
    >
      {children}
    </button>
  );
}

export function Lightbox({ urls, notes, initialIndex, onClose }: {
  urls: string[];
  notes: string[];
  initialIndex: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const touchRef = useRef<{ x: number; y: number } | null>(null);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const goNext = useCallback(() => {
    setIdx((i) => (i + 1) % urls.length);
    resetView();
  }, [urls.length, resetView]);
  const goPrev = useCallback(() => {
    setIdx((i) => (i - 1 + urls.length) % urls.length);
    resetView();
  }, [urls.length, resetView]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP)), []);
  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const next = Math.max(ZOOM_MIN, z - ZOOM_STEP);
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) await el.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      // browser may block
    }
  }, []);

  useEffect(() => {
    function onFsChange() { setIsFullscreen(!!document.fullscreenElement); }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    return () => { prevFocus?.focus?.(); };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (document.fullscreenElement) return;
        // Capture-phase on window runs before Radix's document listener, so Esc closes only the
        // viewer and not the dialog it was opened from.
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowRight") goNext();
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "+" || e.key === "=") zoomIn();
      if (e.key === "-" || e.key === "_") zoomOut();
      if (e.key === "0") resetView();
      if (e.key === "f" || e.key === "F") toggleFullscreen();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, goNext, goPrev, zoomIn, zoomOut, resetView, toggleFullscreen]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [zoomIn, zoomOut]);

  function onMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (zoom <= 1) return;
    e.preventDefault();
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    setPan({
      x: dragRef.current.px + (e.clientX - dragRef.current.x),
      y: dragRef.current.py + (e.clientY - dragRef.current.y),
    });
  }
  function onMouseUp() { dragRef.current = null; }

  // Swipe between screenshots on touch screens (only when not zoomed).
  function onTouchStart(e: React.TouchEvent) {
    if (zoom > 1 || e.touches.length !== 1) return;
    touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start || urls.length < 2) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? goNext : goPrev)();
  }

  const hasThumbBar = urls.length > 1;
  const hasNote = !!notes[idx];
  const topOffset = 60;
  const bottomOffset = (hasThumbBar ? 72 : 12) + (hasNote ? 52 : 0);

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={st("viewerAria", { n: idx + 1, total: urls.length })}
      className="pointer-events-auto fixed inset-0 z-modal select-none overflow-hidden bg-background/95"
      onClick={onClose}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Top toolbar */}
      <div className="absolute inset-x-0 top-0 z-raised flex h-[60px] items-center justify-between gap-2 px-3" onClick={(e) => e.stopPropagation()}>
        <span className="glass-field px-3 py-1 text-xs font-medium tabular-nums text-foreground" aria-live="polite">
          {idx + 1} / {urls.length}
        </span>
        <div className="glass-field flex items-center gap-0.5 p-1">
          <LbBtn label={st("zoomOut")} onClick={zoomOut} disabled={zoom <= ZOOM_MIN}><ZoomOut aria-hidden="true" /></LbBtn>
          <span className="hidden w-11 text-center text-xs tabular-nums text-muted-foreground sm:inline">{Math.round(zoom * 100)}%</span>
          <LbBtn label={st("zoomIn")} onClick={zoomIn} disabled={zoom >= ZOOM_MAX}><ZoomIn aria-hidden="true" /></LbBtn>
          <LbBtn label={st("zoomReset")} onClick={resetView} disabled={zoom === 1 && pan.x === 0 && pan.y === 0}><RotateCcw aria-hidden="true" /></LbBtn>
          <span className="hidden sm:contents">
            <LbBtn label={st("fullscreen")} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</LbBtn>
          </span>
          <a
            href={urls[idx]}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={st("newTab")}
            aria-label={st("newTab")}
            className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink className="h-[18px] w-[18px]" aria-hidden="true" />
          </a>
          <LbBtn label={st("close")} onClick={onClose} btnRef={closeBtnRef}><X aria-hidden="true" /></LbBtn>
        </div>
      </div>

      {/* Prev / Next */}
      {urls.length > 1 && (
        <>
          <button
            type="button"
            aria-label={st("prev")}
            title={st("prev")}
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            className="glass-field absolute left-3 top-1/2 z-raised hidden h-11 w-11 -translate-y-1/2 place-items-center text-foreground sm:grid"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={st("next")}
            title={st("next")}
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            className="glass-field absolute right-3 top-1/2 z-raised hidden h-11 w-11 -translate-y-1/2 place-items-center text-foreground sm:grid"
          >
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </>
      )}

      {/* Image */}
      <div
        className="absolute inset-x-0 flex items-center justify-center overflow-hidden px-2 sm:px-16"
        style={{ top: topOffset, bottom: bottomOffset, cursor: zoom > 1 ? (dragRef.current ? "grabbing" : "grab") : "default" }}
        onMouseDown={onMouseDown}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          key={urls[idx]}
          src={urls[idx]}
          alt={altOf(idx + 1, notes[idx])}
          className="rounded-xl shadow-2xl motion-reduce:!transition-none"
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transition: dragRef.current ? "none" : "transform 0.15s cubic-bezier(.2,.8,.2,1)",
            transformOrigin: "center center",
            display: "block",
          }}
          draggable={false}
          onDoubleClick={(e) => { e.stopPropagation(); if (zoom > 1) resetView(); else setZoom(2); }}
        />
      </div>

      {/* Note */}
      {hasNote && (
        <div className="absolute inset-x-0 z-raised flex justify-center px-3" style={{ bottom: hasThumbBar ? 72 : 12 }} onClick={(e) => e.stopPropagation()}>
          <div className="glass-field flex max-w-xl items-start gap-2 !rounded-2xl px-4 py-2 text-sm text-foreground">
            <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" aria-hidden="true" />
            <span className="whitespace-pre-wrap">{notes[idx]}</span>
          </div>
        </div>
      )}

      {/* Thumbnails */}
      {hasThumbBar && (
        <div className="absolute inset-x-0 bottom-0 z-raised flex h-[72px] items-center justify-center px-3" onClick={(e) => e.stopPropagation()}>
          <div className="glass-field flex max-w-full items-center gap-1.5 overflow-x-auto !rounded-2xl p-1.5">
            {urls.map((url, i) => (
              <button
                key={i}
                type="button"
                aria-label={st("alt", { n: i + 1 })}
                aria-current={i === idx ? "true" : undefined}
                onClick={(e) => { e.stopPropagation(); setIdx(i); resetView(); }}
                className={cn(
                  "h-10 w-16 shrink-0 overflow-hidden rounded-lg transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  i === idx ? "opacity-100 ring-2 ring-primary" : "opacity-60 hover:opacity-90",
                )}
              >
                <img src={url} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

/* ───────────────────────── Thumbs (lists) ───────────────────────── */

export function ScreenshotThumbs({ urls, notes, max = 3, thumbClass }: {
  urls?: string | null;
  notes?: string | null;
  max?: number;
  thumbClass?: string;
}) {
  const list = (urls || "").split("\n").map((u) => safeHttpUrl(u)).filter((u): u is string => !!u);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  if (!list.length) return null;
  const notesList = stringToScreenshotNotes(notes, list.length);
  const visible = list.slice(0, max);
  const extra = list.length - visible.length;
  return (
    <>
      <div className="mt-1 flex items-end gap-1">
        {visible.map((url, i) => (
          <button
            key={i}
            type="button"
            onClick={(e) => { e.stopPropagation(); setLightboxIdx(i); }}
            className={cn(
              "group relative block overflow-hidden rounded-lg border border-[var(--field-border)] transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              thumbClass || "h-10 w-14",
            )}
            title={st("openPreview")}
            aria-label={st("open", { n: i + 1 })}
          >
            <img src={url} alt="" className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100" onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }} />
            <span className="absolute inset-0 grid place-items-center bg-background/0 transition-colors group-hover:bg-background/30">
              <ZoomIn className="h-4 w-4 text-foreground opacity-0 transition-opacity group-hover:opacity-90" aria-hidden="true" />
            </span>
          </button>
        ))}
        {extra > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setLightboxIdx(visible.length); }}
            className="grid h-6 min-w-6 place-items-center self-end rounded-full bg-[var(--glass-bg)] px-1.5 text-2xs font-medium tabular-nums text-muted-foreground hover:text-primary"
            aria-label={st("more", { count: extra })}
            title={st("more", { count: extra })}
          >
            +{extra}
          </button>
        )}
      </div>
      {lightboxIdx !== null && (
        <Lightbox urls={list} notes={notesList} initialIndex={lightboxIdx} onClose={() => setLightboxIdx(null)} />
      )}
    </>
  );
}

/* ───────────────────────── Display (detail views) ───────────────────────── */

interface ScreenshotDisplayProps {
  urls: string;
  notes?: string | null;
  onNotesChange?: (notes: string) => void;
}

export function ScreenshotDisplay({ urls, notes, onNotesChange }: ScreenshotDisplayProps) {
  const list = urls.split("\n").map((u) => safeHttpUrl(u)).filter((u): u is string => !!u);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  if (!list.length) return null;

  const notesList = stringToScreenshotNotes(notes, list.length);

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <div className="micro-label flex items-center gap-1.5">
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          {st("countLabel", { count: list.length })}
        </div>
        <div className={cn("grid gap-3", list.length === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3")}>
          {list.map((url, i) => (
            <ScreenshotItem
              key={i}
              url={url}
              index={i}
              single={list.length === 1}
              note={notesList[i] || ""}
              onNoteChange={onNotesChange ? (newNote) => {
                const updated = [...notesList];
                updated[i] = newNote;
                onNotesChange(screenshotNotesToString(updated));
              } : undefined}
              onZoom={() => setLightboxIdx(i)}
            />
          ))}
        </div>
      </div>
      {lightboxIdx !== null && (
        <Lightbox urls={list} notes={notesList} initialIndex={lightboxIdx} onClose={() => setLightboxIdx(null)} />
      )}
    </>
  );
}

function ScreenshotItem({ url, index, note, onNoteChange, onZoom, single }: {
  url: string;
  index: number;
  note: string;
  onNoteChange?: (note: string) => void;
  onZoom: () => void;
  single?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const [failed, setFailed] = useState(false);

  function save() {
    onNoteChange?.(draft);
    setEditing(false);
  }
  function startEdit() {
    setDraft(note);
    setEditing(true);
  }

  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return null;
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <div className="group relative overflow-hidden rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)]">
        {failed ? (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex aspect-video flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <ImageOff className="h-5 w-5" aria-hidden="true" />
            <span className="text-xs">{st("previewOpenLink")}</span>
            <span className="max-w-[90%] truncate text-2xs">{hostOf(safeUrl)}</span>
          </a>
        ) : (
          <button type="button" onClick={onZoom} className="block w-full" aria-label={st("zoomShot", { n: index + 1 })}>
            <img
              src={safeUrl}
              alt={altOf(index + 1, note)}
              loading="lazy"
              className={cn("w-full object-contain", single ? "max-h-[28rem]" : "max-h-64")}
              onError={() => setFailed(true)}
            />
            <span className="absolute inset-0 grid place-items-center bg-background/0 transition-colors group-hover:bg-background/20">
              <ZoomIn className="h-7 w-7 text-foreground opacity-0 drop-shadow transition-opacity group-hover:opacity-80" aria-hidden="true" />
            </span>
          </button>
        )}
        <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-background/80 px-1.5 text-2xs font-medium tabular-nums text-foreground backdrop-blur">
          {index + 1}
        </span>
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={st("openNewTab", { n: index + 1 })}
          title={st("openNewTab", { n: index + 1 })}
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-background/80 text-foreground opacity-100 backdrop-blur transition-opacity hover:bg-background md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>
      {editing ? (
        <div className="flex items-start gap-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            autoFocus
            aria-label={st("noteAria", { n: index + 1 })}
            className="glass-field min-h-[60px] flex-1 resize-none !rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            placeholder={st("noteEditPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
              if (e.key === "Escape") { e.stopPropagation(); setEditing(false); }
            }}
          />
          <button type="button" aria-label={st("saveNoteAria")} title={st("saveNoteTitle")} onClick={save} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-up hover:bg-up/15">
            <Check className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" aria-label={st("cancelEdit")} title={commonI18n.t("actions.cancel")} onClick={() => setEditing(false)} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : note ? (
        <figcaption className="group/note flex items-start gap-1.5 rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-sm text-muted-foreground">
          <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--chart-3))]" aria-hidden="true" />
          <span className="flex-1 whitespace-pre-wrap text-foreground/90">{note}</span>
          {onNoteChange && (
            <button
              type="button"
              aria-label={st("editNote")}
              title={st("editNote")}
              onClick={startEdit}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground opacity-100 transition-opacity hover:text-primary focus-visible:opacity-100 md:opacity-0 md:group-hover/note:opacity-100"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </figcaption>
      ) : onNoteChange ? (
        <button type="button" onClick={startEdit} className="inline-flex min-h-7 items-center gap-1.5 self-start rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-primary">
          <StickyNote className="h-3.5 w-3.5" aria-hidden="true" /> {st("addNote")}
        </button>
      ) : null}
    </figure>
  );
}
