import { Fragment } from "react";
import { ArrowDown, ArrowUp, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { SECTION_META, type SectionId } from "./use-dashboard";
import { dashboardI18n } from "@/i18n/ns/dashboard";

/** Reorder / hide dashboard sections. Saved per viewer in localStorage. */
export function CustomizePopover({
  order,
  hidden,
  onChange,
  onReset,
  staff = false,
}: {
  staff?: boolean;
  order: SectionId[];
  hidden: SectionId[];
  onChange: (patch: { order?: SectionId[]; hidden?: SectionId[] }) => void;
  onReset: () => void;
}) {
  const { t } = dashboardI18n.useT();
  // Staff-only blocks are not offered to traders; moving swaps with the nearest visible-in-list neighbour.
  const list = order.filter((id) => staff || !SECTION_META[id].staffOnly);
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const a = order.indexOf(list[idx]);
    const b = order.indexOf(list[j]);
    const next = [...order];
    [next[a], next[b]] = [next[b], next[a]];
    onChange({ order: next });
  };
  const toggle = (id: SectionId, visible: boolean) =>
    onChange({ hidden: visible ? hidden.filter((h) => h !== id) : [...hidden, id] });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          aria-label={t("customize.button")}
          title={t("customize.button")}
        >
          <SlidersHorizontal aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      {/* bottom 80: clear the fixed mobile bottom nav; height follows the space Radix reports. */}
      <PopoverContent
        align="end"
        collisionPadding={{ top: 12, right: 12, left: 12, bottom: 80 }}
        className="max-h-[min(640px,var(--radix-popover-content-available-height,80dvh))] w-[min(92vw,360px)] overflow-y-auto p-3"
      >
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <div>
            <p className="text-sm font-semibold">{t("customize.title")}</p>
            <p className="text-xs text-muted-foreground">{t("customize.hint")}</p>
          </div>
        </div>
        <ul className="flex flex-col gap-1">
          {list.map((id, idx) => {
            const visible = !hidden.includes(id);
            const meta = SECTION_META[id];
            const switchId = `dash-sec-${id}`;
            const firstExtra = meta.extra && !list.slice(0, idx).some((x) => SECTION_META[x].extra);
            return (
              <Fragment key={id}>
                {firstExtra && (
                  <li className="mt-1 border-t border-border/60 px-1 pb-0.5 pt-2" aria-hidden="true">
                    <span className="micro-label">{t("customize.extra")}</span>
                  </li>
                )}
                <li className="flex items-center gap-2 rounded-xl px-1 py-1.5 hover:bg-[var(--glass-hover-bg)]">
                  <Switch id={switchId} checked={visible} onCheckedChange={(v) => toggle(id, v)} />
                  <label htmlFor={switchId} className="min-w-0 flex-1 cursor-pointer">
                    <span className={`block truncate text-sm ${visible ? "" : "text-muted-foreground"}`}>
                      {meta.label}
                    </span>
                    <span className="block truncate text-2xs text-muted-foreground" title={meta.hint}>{meta.hint}</span>
                  </label>
                  <div className="flex shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={idx === 0}
                      onClick={() => move(idx, -1)}
                      aria-label={t("customize.up", { label: meta.label })}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={idx === list.length - 1}
                      onClick={() => move(idx, 1)}
                      aria-label={t("customize.down", { label: meta.label })}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              </Fragment>
            );
          })}
        </ul>
        <div className="mt-2 flex items-center justify-end gap-2 border-t border-border/60 px-1 pt-2">
          <Button variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw aria-hidden="true" />
            {t("customize.reset")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
