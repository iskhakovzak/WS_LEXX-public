import * as React from "react";
import { forwardRef } from "react";
import { ArrowUpRight, Bell, Database, Palette, Plug, Search, ShieldCheck, SlidersHorizontal, UserRound, Users, type LucideIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { Capability } from "@/lib/permissions";
import { settingsI18n } from "@/i18n/ns/settings";
import { commonI18n } from "@/i18n/ns/common";

export type SectionId = "profile" | "appearance" | "trading" | "notifications" | "team" | "permissions" | "data" | "integrations";

export type SectionMeta = {
  id: SectionId;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Extra words the settings search matches (Russian, English and Uzbek terms), on top of the translated label. */
  keywords: string;
  /** Shown only when the viewer holds at least one of these capabilities (see auth-context `can`). */
  requiresAny?: Capability[];
  /** The section lives on another page now: selecting it navigates there instead of rendering here. */
  href?: string;
};

/** Section entry whose label/description follow the UI language (getters). */
function section(id: SectionId, icon: LucideIcon, extra: Pick<SectionMeta, "keywords" | "requiresAny" | "href">): SectionMeta {
  return {
    id, icon, ...extra,
    get label() { return settingsI18n.t(`sections.${id}.label`); },
    get description() { return settingsI18n.t(`sections.${id}.description`); },
  };
}

export const SECTIONS: SectionMeta[] = [
  section("profile", UserRound, {
    keywords: "профиль пароль сессии выйти куратор ментор риск-менеджер аккаунт password profile sessions account profil parol sessiya" }),
  section("appearance", Palette, {
    keywords: "тема тёмная темная светлая сумеречная dim dark light оформление вид theme appearance mavzu koʻrinish" }),
  section("trading", SlidersHorizontal, {
    keywords: "счёт счет риск комиссия плечо leverage горизонт интрадей овернайт свинг чек-лист checklist покупательная buying power размер позиции account risk fees horizon hisob komissiya leverej savdo" }),
  section("notifications", Bell, {
    keywords: "уведомления дайджест digest email почта утро вечер расписание оповещения notifications alerts bildirishnoma dayjest xabarnoma" }),
  section("team", Users, {
    keywords: "команда пользователи роли пригласить добавить деактивировать куратор ментор риск-менеджер назначения users team invite roles jamoa foydalanuvchi",
    requiresAny: ["users.read.team"], href: "/admin?tab=people" }),
  section("permissions", ShieldCheck, {
    keywords: "права доступ роли матрица разрешения permissions capabilities куратор админ трейдер scope закреплённые access huquq ruxsat",
    requiresAny: ["users.read.team", "permissions.manage"], href: "/admin?tab=roles" }),
  section("data", Database, {
    keywords: "данные экспорт импорт csv json бэкап backup база выгрузка data export maʼlumot eksport zaxira" }),
  section("integrations", Plug, {
    keywords: "интеграции telegram телеграм бот привязать отвязать рассылка broadcast integrations bot integratsiya" }),
];

export function visibleSections(can: (cap: Capability) => boolean): SectionMeta[] {
  return SECTIONS.filter((s) => !s.requiresAny || s.requiresAny.some((c) => can(c)));
}

export function matchSections(list: SectionMeta[], q: string): SectionMeta[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((s) => `${s.label} ${s.description} ${s.keywords}`.toLowerCase().includes(needle));
}

type NavProps = {
  sections: SectionMeta[];
  active: SectionId;
  onSelect: (id: SectionId) => void;
  query: string;
  onQuery: (q: string) => void;
  badges?: Partial<Record<SectionId, React.ReactNode>>;
};

/** Desktop: sticky vertical nav with search. Mobile: search + horizontally scrolling chips. */
export const SettingsNav = forwardRef<HTMLInputElement, NavProps>(function SettingsNav(
  { sections, active, onSelect, query, onQuery, badges },
  searchRef,
) {
  const { t } = settingsI18n.useT();
  const filtered = matchSections(sections, query);
  const listRef = React.useRef<HTMLDivElement>(null);

  function onListKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-nav]") ?? []);
    const i = items.findIndex((b) => b === document.activeElement);
    const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  }

  return (
    <nav aria-label={t("nav.aria")} className="flex flex-col gap-2 lg:sticky lg:top-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered[0]) { onSelect(filtered[0].id); onQuery(""); (e.target as HTMLInputElement).blur(); }
            if (e.key === "Escape") { onQuery(""); (e.target as HTMLInputElement).blur(); }
          }}
          placeholder={t("nav.search")}
          aria-label={t("nav.searchAria")}
          className="glass-field h-9 w-full rounded-full pl-10 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <Kbd className="absolute right-3 top-1/2 hidden -translate-y-1/2 lg:inline-flex">/</Kbd>
      </div>

      {/* Mobile / tablet: chips */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden" role="tablist" aria-label={t("nav.sections")}>
        {filtered.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active === s.id}
            data-active={active === s.id}
            onClick={() => onSelect(s.id)}
            className={cn(
              "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors",
              active === s.id ? "bg-primary-solid text-primary-foreground" : "chip",
            )}
          >
            <s.icon className="h-3.5 w-3.5" aria-hidden="true" />
            {s.label}
            {s.href && <ArrowUpRight className="h-3 w-3 text-muted-foreground" aria-label={t("nav.inConsole")} />}
          </button>
        ))}
      </div>

      {/* Desktop: vertical list */}
      <div ref={listRef} onKeyDown={onListKey} className="glass-panel hidden flex-col gap-0.5 rounded-2xl p-1.5 lg:flex">
        {filtered.map((s) => {
          const idx = sections.findIndex((x) => x.id === s.id) + 1;
          const isActive = active === s.id;
          return (
            <button
              key={s.id}
              type="button"
              data-nav
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelect(s.id)}
              title={s.description}
              className={cn(
                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive ? "bg-primary/12 text-foreground" : "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground",
              )}
            >
              <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", isActive ? "bg-primary-solid text-primary-foreground" : "bg-[var(--glass-bg)]")}>
                <s.icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.label}</span>
                <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{s.description}</span>
              </span>
              {badges?.[s.id]}
              {s.href && <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("nav.opensInConsole")} />}
              {idx <= 9 && <Kbd className="opacity-0 transition-opacity group-hover:opacity-100">{idx}</Kbd>}
            </button>
          );
        })}
        {filtered.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted-foreground">{commonI18n.t("states.nothingFound")}</p>}
      </div>
      {filtered.length === 0 && <p className="px-1 text-xs text-muted-foreground lg:hidden">{commonI18n.t("states.nothingFound")}</p>}
    </nav>
  );
});
