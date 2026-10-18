import { useCallback, useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, Loader2, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaUrl } from "./media";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { commonI18n } from "@/i18n/ns/common";

export type LightboxItem =
  | { kind: "media"; id: number; caption: string }
  | { kind: "url"; src: string; caption: string; href?: string };

/**
 * Full-screen viewer for plan screenshots and TradingView snapshots. Built on the Radix dialog primitive so it
 * stacks correctly above the editor sheet (focus trap, Esc closes only the top layer). Layer: z-modal.
 */
export function PlanLightbox({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: LightboxItem[];
  index: number | null;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}) {
  const { t } = gpI18n.useT();
  const open = index !== null && !!items[index];
  const [zoom, setZoom] = useState(false);
  useEffect(() => setZoom(false), [index]);

  const go = useCallback(
    (dir: 1 | -1) => {
      if (index === null || items.length < 2) return;
      onIndexChange((index + dir + items.length) % items.length);
    },
    [index, items.length, onIndexChange],
  );

  const item = open ? items[index!] : null;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-modal bg-background/95 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-modal flex flex-col outline-none"
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              go(1);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              go(-1);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("media.lightboxTitle", { n: index !== null ? index + 1 : 0, total: items.length })}
          </DialogPrimitive.Title>
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
            <span className="text-sm tabular-nums text-muted-foreground">
              {index !== null ? index + 1 : 0} / {items.length}
            </span>
            <div className="flex items-center gap-1">
              <IconBtn label={zoom ? t("media.fit") : t("media.actual")} onClick={() => setZoom((z) => !z)}>
                {zoom ? <ZoomOut /> : <ZoomIn />}
              </IconBtn>
              {item?.kind === "url" && (
                <a
                  href={item.href ?? item.src}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                  className="chip inline-flex min-h-9 items-center gap-1.5 px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("media.openInTv")}
                </a>
              )}
              <DialogPrimitive.Close asChild>
                <IconBtn label={t("media.closeEsc")}>
                  <X />
                </IconBtn>
              </DialogPrimitive.Close>
            </div>
          </div>

          <div className="relative min-h-0 flex-1">
            <div className={cn("absolute inset-0 flex px-4 pb-4 sm:px-16", zoom ? "items-start justify-start overflow-auto" : "items-center justify-center")}>
              {item && <LightboxImage item={item} zoom={zoom} onToggleZoom={() => setZoom((z) => !z)} />}
            </div>
            {items.length > 1 && (
              <>
                <NavBtn side="left" label={t("media.prev")} onClick={() => go(-1)} />
                <NavBtn side="right" label={t("media.next")} onClick={() => go(1)} />
              </>
            )}
          </div>

          {item?.caption && (
            <p className="mx-auto mb-4 max-w-3xl shrink-0 rounded-xl bg-[var(--glass-bg)] px-4 py-2 text-center text-sm text-foreground">{item.caption}</p>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function LightboxImage({ item, zoom, onToggleZoom }: { item: LightboxItem; zoom: boolean; onToggleZoom: () => void }) {
  const { t } = gpI18n.useT();
  const mediaSrc = useMediaUrl(item.kind === "media" ? item.id : null);
  const [failed, setFailed] = useState(false);
  const src = item.kind === "media" ? (mediaSrc === "error" ? null : mediaSrc) : item.src;
  useEffect(() => setFailed(false), [src]);
  if ((item.kind === "media" && mediaSrc === "error") || failed) {
    return (
      <div className="m-auto flex flex-col items-center gap-2 text-muted-foreground">
        <ImageOff className="h-8 w-8" aria-hidden="true" />
        <span className="text-sm">{t("media.imageUnavailable")}</span>
      </div>
    );
  }
  if (!src) return <Loader2 className="m-auto h-8 w-8 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label={commonI18n.t("states.loading")} />;
  return (
    <img
      src={src}
      alt={item.caption || t("media.screenshot")}
      referrerPolicy="no-referrer"
      onClick={onToggleZoom}
      onError={() => setFailed(true)}
      className={cn(
        "select-none rounded-xl shadow-2xl",
        zoom ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain",
      )}
      draggable={false}
    />
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-[18px] [&_svg]:w-[18px]"
    >
      {children}
    </button>
  );
}

function NavBtn({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "glass-field absolute top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      {side === "left" ? <ChevronLeft className="h-5 w-5" aria-hidden="true" /> : <ChevronRight className="h-5 w-5" aria-hidden="true" />}
    </button>
  );
}
