/** Header right-side controls: language, theme toggle, notifications bell (popover) and the user menu. */
import React from "react";
import { useLocation } from "wouter";
import { CloudMoon, LogOut, Moon, Settings, Sun, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";
import { useTheme, type Theme } from "@/contexts/theme-context";
import { NotificationBell as NotificationBellImpl } from "@/components/notifications/notification-bell";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";
import { personInitials, personName } from "@/i18n";

export { LanguageMenu } from "@/i18n/language-switcher";
import { LanguageMenuItems } from "@/i18n/language-switcher";

export const THEME_ICONS: Record<Theme, React.ElementType> = { dark: Moon, dim: CloudMoon, light: Sun };

function roleLabel(role: string): string {
  const t = commonI18n.t;
  if (role === "trader") return t("roles.trader");
  if (role === "curator") return t("roles.curator");
  if (role === "admin") return t("roles.administrator");
  if (role === "guest") return t("roles.guest");
  return role;
}

const iconBtn =
  "chip relative grid h-10 w-10 shrink-0 place-items-center focus-visible:ring-2 focus-visible:ring-ring";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycleTheme, themeLabel, themes, themeLabels } = useTheme();
  const next = themes[(themes.indexOf(theme) + 1) % themes.length];
  const Icon = THEME_ICONS[theme];
  const { t } = commonI18n.useT();
  return (
    <button
      type="button"
      onClick={cycleTheme}
      className={cn(iconBtn, className)}
      title={t("theme.toggleTitle", { current: themeLabel, next: themeLabels[next] })}
      aria-label={t("theme.toggleAria", { current: themeLabel, next: themeLabels[next] })}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/**
 * Bell with unread badge + popover (components/notifications/notification-bell.tsx).
 * `traderName` is accepted for backwards compatibility with the layout; identity comes from the auth context.
 */
export function NotificationBell(_props: { traderName?: string; className?: string }) {
  return <NotificationBellImpl className={_props.className} />;
}

export function UserMenu() {
  const { user, logout } = useAuth();
  const { theme, setTheme, themes, themeLabels } = useTheme();
  const [, navigate] = useLocation();
  const { t } = commonI18n.useT();
  const { t: ts } = shellI18n.useT();
  const member = user && user.role !== "guest" ? user.traderName ?? null : null;
  const name = member ? personName(member) : user && user.role !== "guest" ? t("roles.user") : t("roles.guest");
  const role = roleLabel(user?.role ?? "guest");
  const initial = member ? personInitials(member) : name.trim().charAt(0).toUpperCase() || "?";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-i18n-focus="user-menu" className={cn(iconBtn, "font-semibold text-foreground")} aria-label={ts("header.userMenuAria", { name })} title={name}>
          <span aria-hidden="true" className="text-sm">{initial}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-60">
        <DropdownMenuLabel className="flex items-center gap-3 py-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
            <User className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground" title={name}>{name}</span>
            <span className="block text-xs font-normal text-muted-foreground">{role}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("theme.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          {themes.map((t) => {
            const Icon = THEME_ICONS[t];
            return (
              <DropdownMenuRadioItem key={t} value={t} className="gap-2">
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {themeLabels[t]}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* Language here too: on phones the header language button is hidden. */}
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground md:hidden">{t("language.label")}</DropdownMenuLabel>
        <div className="md:hidden">
          <LanguageMenuItems focus='[data-i18n-focus="user-menu"]' />
          <DropdownMenuSeparator />
        </div>
        <DropdownMenuItem onSelect={() => navigate("/settings")} className="gap-2">
          <Settings className="h-4 w-4" aria-hidden="true" />
          {t("actions.settings")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={logout} className="gap-2 text-destructive focus:text-destructive">
          <LogOut className="h-4 w-4" aria-hidden="true" />
          {t("actions.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
