import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { BarChart3, Camera, ExternalLink, ImageOff, ImagePlus, Link2, Loader2, Maximize2, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToastAction } from "@/components/ui/toast";
import { Pill } from "@/components/ds";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { imageFilesFrom, uploadPlanImage, useMediaUrl, type MediaContext } from "./media";
import { PlanLightbox, type LightboxItem } from "./plan-lightbox";
import { extractTradingViewUrls, parseTradingViewUrl, tradingViewChartFor, type TradingViewLink } from "./tradingview";
import type { MediaRef } from "./types";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { commonI18n } from "@/i18n/ns/common";

/* ── Paste routing ─────────────────────────────────────────────────────────────
 * Ctrl+V anywhere in the editor: images go to the block that holds focus (a ticker card or the plan),
 * TradingView links pasted outside text fields become chart links of that block.
 * Blocks mark themselves with data-paste-target="<key>" and register handlers here.
 */
export type PasteHandlers = { addFiles: (files: File[]) => void; addTvLinks?: (urls: string[]) => void; label: string };
type Router = { register: (key: string, h: PasteHandlers) => () => void; get: (key: string) => PasteHandlers | undefined };
const PasteRouterContext = createContext<Router | null>(null);

export function PasteRouterProvider({ children }: { children: React.ReactNode }) {
  const map = useRef(new Map<string, PasteHandlers>());
  const router = useMemo<Router>(
    () => ({
      register: (key, h) => {
        map.current.set(key, h);
        return () => {
          if (map.current.get(key) === h) map.current.delete(key);
        };
      },
      get: (key) => map.current.get(key),
    }),
    [],
  );
  return <PasteRouterContext.Provider value={router}>{children}</PasteRouterContext.Provider>;
}

export function usePasteRouter() {
  return useContext(PasteRouterContext);
}

function useRegisterPaste(key: string | undefined, handlers: PasteHandlers) {
  const router = usePasteRouter();
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!router || !key) return;
    return router.register(key, {
      label: handlers.label,
      addFiles: (f) => ref.current.addFiles(f),
      addTvLinks: handlers.addTvLinks ? (u) => ref.current.addTvLinks?.(u) : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, key, handlers.label, !!handlers.addTvLinks]);
}

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  return h.isContentEditable || h.tagName === "TEXTAREA" || (h.tagName === "INPUT" && !["checkbox", "radio", "button", "file"].includes((h as HTMLInputElement).type));
}

/**
 * Attach to the editor root: routes clipboard images / TradingView links to the focused block.
 * Also listens on document while mounted so a paste with nothing focused still lands in the plan.
 */
export function useEditorPaste(rootRef: React.RefObject<HTMLElement | null>, fallbackKey = "plan", enabled = true) {
  const router = usePasteRouter();
  useEffect(() => {
    if (!router || !enabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const root = rootRef.current;
      const target = e.target as Element | null;
      const inside = !!root && !!target && root.contains(target);
      if (!inside && target !== document.body && target !== document.documentElement) return;
      const key = (target?.closest?.("[data-paste-target]") as HTMLElement | null)?.dataset.pasteTarget ?? fallbackKey;
      const h = router.get(key) ?? router.get(fallbackKey);
      if (!h) return;
      const files = imageFilesFrom(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        h.addFiles(files);
        return;
      }
      if (isTextField(target)) return; // normal text paste
      const urls = extractTradingViewUrls(e.clipboardData?.getData("text/plain") ?? "");
      if (urls.length > 0 && h.addTvLinks) {
        e.preventDefault();
        h.addTvLinks(urls);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [router, rootRef, fallbackKey, enabled]);
}

/* ── Thumbnails ────────────────────────────────────────────────────────────── */
function MediaImg({ id, alt, className }: { id: number; alt: string; className?: string }) {
  const { t } = gpI18n.useT();
  const src = useMediaUrl(id);
  if (src === "error")
    return (
      <span className={cn("flex flex-col items-center justify-center gap-1 text-muted-foreground", className)}>
        <ImageOff className="h-5 w-5" aria-hidden="true" />
        <span className="text-xs">{t("media.unavailable")}</span>
      </span>
    );
  if (!src) return <span className={cn("block animate-pulse bg-[var(--glass-bg)] motion-reduce:animate-none", className)} aria-label={commonI18n.t("states.loading")} />;
  return <img src={src} alt={alt} loading="lazy" draggable={false} className={cn("object-cover", className)} />;
}

/* ── Editor strip ──────────────────────────────────────────────────────────── */
type Pending = { key: string; preview: string };

/**
 * Screenshots of one block in the editor: paste (via router), drop, file picker; caption per image; remove.
 * Removal only drops the reference — the server soft-deletes the image when the plan is saved without it.
 */
export function MediaStrip({
  refs,
  onChange,
  context,
  date,
  max,
  pasteKey,
  label,
  onAddTvLinks,
  disabled,
}: {
  refs: MediaRef[];
  onChange: (update: (prev: MediaRef[]) => MediaRef[]) => void;
  context: MediaContext;
  date: string;
  max: number;
  pasteKey?: string;
  label: string;
  onAddTvLinks?: (urls: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = gpI18n.useT();
  const [pending, setPending] = useState<Pending[]>([]);
  const [over, setOver] = useState(false);
  const [lb, setLb] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const room = Math.max(0, max - refs.length - pending.length);

  const addFiles = useCallback(
    (files: File[]) => {
      if (disabled) return;
      const take = files.slice(0, room);
      if (take.length < files.length) toast({ title: gpI18n.t("media.tooMany", { max, label }) });
      for (const f of take) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const preview = URL.createObjectURL(f);
        setPending((p) => [...p, { key, preview }]);
        uploadPlanImage(f, context, date)
          .then((m) => onChange((prev) => (prev.some((r) => r.id === m.id) ? prev : [...prev, { id: m.id, caption: "" }])))
          .catch((err) => toast({ title: gpI18n.t("media.uploadFailed"), description: err instanceof Error ? err.message : undefined, variant: "destructive" }))
          .finally(() => {
            setPending((p) => p.filter((x) => x.key !== key));
            URL.revokeObjectURL(preview);
          });
      }
    },
    [room, max, label, context, date, onChange, disabled],
  );

  useRegisterPaste(pasteKey, { addFiles, addTvLinks: onAddTvLinks, label });

  const remove = (id: number) => {
    const idx = refs.findIndex((r) => r.id === id);
    const removed = refs[idx];
    onChange((prev) => prev.filter((r) => r.id !== id));
    if (removed)
      toast({
        title: t("media.removed"),
        description: t("media.removedDesc"),
        action: (
          <ToastAction
            altText={t("media.restoreAlt")}
            onClick={() => onChange((prev) => (prev.some((r) => r.id === id) ? prev : [...prev.slice(0, idx), removed, ...prev.slice(idx)]))}
          >
            {t("media.restore")}
          </ToastAction>
        ),
      });
  };

  const items: LightboxItem[] = refs.map((r) => ({ kind: "media", id: r.id, caption: r.caption }));

  return (
    <div
      className="flex flex-col gap-2"
      onDragOver={(e) => {
        if (disabled || !Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        const files = imageFilesFrom(e.dataTransfer);
        setOver(false);
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
    >
      {(refs.length > 0 || pending.length > 0) && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label={t("media.stripAria", { label })}>
          {refs.map((r, i) => (
            <li key={r.id} className="flex min-w-0 flex-col gap-1">
              <div className="group relative aspect-video overflow-hidden rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)]">
                <button type="button" className="block h-full w-full" onClick={() => setLb(i)} aria-label={t("media.open", { n: i + 1 })}>
                  <MediaImg id={r.id} alt={r.caption || t("media.alt", { n: i + 1 })} className="h-full w-full" />
                </button>
                <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                  <TileBtn label={t("media.open", { n: i + 1 })} onClick={() => setLb(i)}>
                    <Maximize2 />
                  </TileBtn>
                  <TileBtn label={t("media.remove", { n: i + 1 })} onClick={() => remove(r.id)} danger>
                    <Trash2 />
                  </TileBtn>
                </div>
              </div>
              <Input
                value={r.caption}
                maxLength={300}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange((prev) => prev.map((x) => (x.id === r.id ? { ...x, caption: v } : x)));
                }}
                placeholder={t("media.captionPlaceholder")}
                aria-label={t("media.captionAria", { n: i + 1 })}
                className="h-8 px-3 text-xs"
              />
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.key} className="relative aspect-video overflow-hidden rounded-xl border border-[var(--field-border)]">
              <img src={p.preview} alt="" className="h-full w-full object-cover opacity-50" />
              <span className="absolute inset-0 grid place-items-center">
                <Loader2 className="h-5 w-5 animate-spin text-foreground motion-reduce:animate-none" aria-label={t("media.uploading")} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {room > 0 && !disabled && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground transition-colors",
            over ? "border-primary bg-primary/10 text-foreground" : "border-[var(--field-border)]",
          )}
        >
          <ImagePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {over ? t("media.dropHere") : (
              <>
                <span className="text-foreground">Ctrl+V</span> {t("media.dropHint")}
              </>
            )}
          </span>
          <input
            ref={fileRef}
            id={inputId}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="sr-only"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5" onClick={() => fileRef.current?.click()}>
            <Plus aria-hidden="true" />
            {t("media.file")}
          </Button>
        </div>
      )}

      <PlanLightbox items={items} index={lb} onIndexChange={setLb} onClose={() => setLb(null)} />
    </div>
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
        danger ? "text-destructive" : "text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/* ── TradingView ───────────────────────────────────────────────────────────── */

/** Preview card: snapshot → image straight from TradingView; chart → ticker + «Открыть в TradingView». */
export function TvLinkCard({
  url,
  onOpenImage,
  onRemove,
  compact,
}: {
  url: string;
  onOpenImage?: (src: string, href: string) => void;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const { t } = gpI18n.useT();
  const tv = useMemo(() => parseTradingViewUrl(url), [url]);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!tv) return null;
  const removeBtn = onRemove && (
    <button
      type="button"
      onClick={onRemove}
      aria-label={t("media.removeTv")}
      title={t("media.removeTvShort")}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-background/80 text-muted-foreground backdrop-blur hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );

  if (tv.kind === "snapshot" && !failed) {
    return (
      <div className="group relative overflow-hidden rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)]">
        <button
          type="button"
          onClick={() => onOpenImage?.(tv.imageUrl, tv.url)}
          className={cn("block w-full", compact ? "aspect-[16/9]" : "aspect-video")}
          aria-label={t("media.openTvSnapshot")}
        >
          <img
            src={tv.imageUrl}
            alt={t("media.tvSnapshotAlt")}
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        </button>
        <div className="absolute left-1.5 top-1.5">
          <Pill tone="neutral" className="bg-background/80 backdrop-blur">
            <BarChart3 className="h-3 w-3" aria-hidden="true" />
            TradingView
          </Pill>
        </div>
        {onRemove && <div className="absolute right-1.5 top-1.5">{removeBtn}</div>}
      </div>
    );
  }
  return <TvChartRow tv={tv} removeBtn={removeBtn} />;
}

function TvChartRow({ tv, removeBtn }: { tv: TradingViewLink; removeBtn?: React.ReactNode }) {
  const { t } = gpI18n.useT();
  const symbol = tv.kind === "chart" ? tv.symbol : null;
  const exchange = tv.kind === "chart" ? tv.exchange : null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)] px-3 py-2">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
        <BarChart3 className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">
          {symbol ?? (tv.kind === "snapshot" ? t("media.snapshot") : t("media.tvChart"))}
          {exchange && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{exchange}</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">{tv.url.replace(/^https:\/\/(www\.)?/, "")}</p>
      </div>
      <a
        href={tv.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className="chip inline-flex min-h-8 shrink-0 items-center gap-1.5 px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        {t("media.openInTv")}
      </a>
      {removeBtn}
    </div>
  );
}

/** Editor input for TradingView links (one for a ticker, several for the plan). */
export function TvLinkField({
  links,
  onChange,
  max,
  label: labelProp,
  placeholder: placeholderProp,
}: {
  links: string[];
  onChange: (links: string[]) => void;
  max: number;
  label?: string;
  placeholder?: string;
}) {
  const { t } = gpI18n.useT();
  const label = labelProp ?? t("media.tvLink");
  const placeholder = placeholderProp ?? t("media.tvPlaceholder");
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [lb, setLb] = useState<{ src: string; href: string } | null>(null);
  const id = useId();

  const commit = (text: string) => {
    const s = text.trim();
    if (!s) return;
    const found = extractTradingViewUrls(s);
    if (found.length === 0) {
      setErr(t("media.tvInvalid"));
      return;
    }
    const next = [...links, ...found.filter((u) => !links.includes(u))].slice(0, max);
    onChange(next);
    setDraft("");
    setErr(null);
  };

  return (
    <div className="flex flex-col gap-2">
      {links.length > 0 && (
        <div className={cn("grid gap-2", links.length > 1 && "sm:grid-cols-2")}>
          {links.map((u) => (
            <TvLinkCard key={u} url={u} compact onOpenImage={(src, href) => setLb({ src, href })} onRemove={() => onChange(links.filter((x) => x !== u))} />
          ))}
        </div>
      )}
      {links.length < max && (
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <div className="relative">
            <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id={id}
              value={draft}
              inputMode="url"
              placeholder={placeholder}
              aria-invalid={!!err}
              aria-describedby={err ? `${id}-err` : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                if (err) setErr(null);
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text/plain");
                if (extractTradingViewUrls(text).length > 0) {
                  e.preventDefault();
                  commit(text);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(draft);
                }
              }}
              onBlur={() => draft.trim() && commit(draft)}
              className="h-9 pl-10 text-sm"
            />
          </div>
          {err && (
            <p id={`${id}-err`} role="alert" className="px-1 text-xs text-destructive">
              {err}
            </p>
          )}
        </div>
      )}
      <PlanLightbox
        items={lb ? [{ kind: "url", src: lb.src, href: lb.href, caption: "" }] : []}
        index={lb ? 0 : null}
        onIndexChange={() => undefined}
        onClose={() => setLb(null)}
      />
    </div>
  );
}

/* ── Read view gallery ─────────────────────────────────────────────────────── */

/**
 * Screenshots + TradingView links of one block, read-only. Snapshots and screenshots share one lightbox;
 * chart links render as cards with «Открыть в TradingView».
 */
export function MediaGallery({
  media,
  tvLinks,
  ticker,
  className,
  dense,
}: {
  media?: MediaRef[] | null;
  tvLinks?: (string | null | undefined)[] | null;
  ticker?: string;
  className?: string;
  dense?: boolean;
}) {
  const { t } = gpI18n.useT();
  const [lb, setLb] = useState<number | null>(null);
  const refs = media ?? [];
  const tvs = (tvLinks ?? []).map((u) => (u ? parseTradingViewUrl(u) : null)).filter((t): t is TradingViewLink => !!t);
  const snaps = tvs.filter((t): t is Extract<TradingViewLink, { kind: "snapshot" }> => t.kind === "snapshot");
  const charts = tvs.filter((t) => t.kind !== "snapshot");
  const items: LightboxItem[] = [
    ...refs.map((r): LightboxItem => ({ kind: "media", id: r.id, caption: r.caption })),
    ...snaps.map((s): LightboxItem => ({ kind: "url", src: s.imageUrl, href: s.url, caption: ticker ? `${ticker} · TradingView` : "TradingView" })),
  ];
  if (items.length === 0 && charts.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {items.length > 0 && (
        <ul className={cn("grid gap-2", dense ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3")} aria-label={ticker ? t("media.galleryOf", { ticker }) : t("media.galleryPlan")}>
          {items.map((it, i) => (
            <li key={it.kind === "media" ? `m${it.id}` : `t${it.src}`} className="min-w-0">
              <button
                type="button"
                onClick={() => setLb(i)}
                className="lift group relative block aspect-video w-full overflow-hidden rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("media.openItem", { name: it.caption || t("media.itemN", { n: i + 1 }) })}
              >
                {it.kind === "media" ? (
                  <MediaImg id={it.id} alt={it.caption || t("media.alt", { n: i + 1 })} className="h-full w-full" />
                ) : (
                  <SnapshotImg src={it.src} />
                )}
                {it.kind === "url" && (
                  <span className="absolute left-1.5 top-1.5 rounded-full bg-background/80 px-1.5 py-0.5 text-xs font-medium backdrop-blur">TradingView</span>
                )}
                {it.caption && it.kind === "media" && (
                  <span className="absolute inset-x-0 bottom-0 truncate bg-background/75 px-2 py-1 text-left text-xs backdrop-blur">{it.caption}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {charts.map((t) => (
        <TvChartRow key={t.url} tv={t} />
      ))}
      <PlanLightbox items={items} index={lb} onIndexChange={setLb} onClose={() => setLb(null)} />
    </div>
  );
}

function SnapshotImg({ src }: { src: string }) {
  const { t } = gpI18n.useT();
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
        <ImageOff className="h-5 w-5" aria-hidden="true" />
        <span className="text-xs">{t("media.snapshotUnavailable")}</span>
      </span>
    );
  return (
    <img src={src} alt={t("media.tvSnapshotAlt")} referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />
  );
}

/** Small «График» link for a ticker without a saved TradingView link. */
export function TvQuickLink({ ticker }: { ticker: string }) {
  return (
    <a
      href={tradingViewChartFor(ticker)}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
      TradingView
      <ExternalLink className="h-3 w-3 opacity-70" aria-hidden="true" />
    </a>
  );
}

export { Camera as MediaIcon };
