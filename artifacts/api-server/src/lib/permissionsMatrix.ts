/**
 * Permissions matrix — PURE core (no DB, no express). Shared by lib/permissions.ts (request helpers),
 * routes/permissions.ts (overrides API) and scripts/check-permissions.mjs (offline check).
 * The frontend keeps a mirror in edge-tracker/src/lib/permissions.ts (same keys + defaults — the offline
 * check compares both files).
 * Texts: the Russian label/description/group below are the source; EN/UZ are in src/i18n/{en,uz}/permissions.ts and
 * lib/permissionsI18n.ts serves them per language (this file stays importable by Node without a bundler).
 *
 * Model
 *  - Role ∈ trader | curator | admin | guest.
 *  - A capability is a string key like "trades.read.team". `*.own` capabilities act on the actor's own data
 *    (target.trader must equal the actor); `team` capabilities act on other members' data and carry a SCOPE:
 *      "desk"     — the whole desk (current behaviour for curators and admins everywhere);
 *      "assigned" — only traders whose assigned_curator / assigned_risk_manager / assigned_mentor is the actor.
 *  - DEFAULT_MATRIX reproduces today's behaviour exactly: curators = admins on everything except the
 *    admin-only capabilities (listed with `adminOnly`). Guests have no capabilities (read-only sentinel scope
 *    is handled by lib/auth scopeTrader).
 *  - Per-desk overrides (table role_permissions) may flip `allowed` and change `scope` for trader/curator;
 *    the admin row is locked (always everything, desk scope) so an admin can never lock themselves out.
 */

export const ROLES = ["trader", "curator", "admin", "guest"] as const;
export type Role = (typeof ROLES)[number];

export type Scope = "desk" | "assigned";

export type CapabilityDef = {
  key: Capability;
  group: string;
  label: string;
  description: string;
  /** Acts on other members' data → carries a scope (desk / assigned). */
  team?: boolean;
  /** Acts only on the actor's own data (target.trader must be the actor). */
  own?: boolean;
  /** Only admins may ever hold it (UI shows it locked for other roles). */
  adminOnly?: boolean;
};

export const CAPABILITIES = [
  // ── Desk-wide reads ──────────────────────────────────────────────────────
  { key: "team.read", group: "Деск", label: "Видеть данные всех трейдеров", team: true,
    description: "Сделки, события, идеи, рейтинги, плейбук-статистика и ленты по любому трейдеру (scopeTrader). Без него — только свои." },
  { key: "users.read.team", group: "Деск", label: "Список команды", team: true,
    description: "Настройки → Команда, /admin/users, назначения куратор/риск/ментор (просмотр)." },

  // ── Trades ───────────────────────────────────────────────────────────────
  { key: "trades.read.own", group: "Сделки", label: "Смотреть свои сделки", own: true, description: "Журнал, исполнения, чек-листы своих сделок." },
  { key: "trades.read.team", group: "Сделки", label: "Смотреть сделки команды", team: true, description: "Сделки и исполнения других трейдеров." },
  { key: "trades.write.own", group: "Сделки", label: "Вести свои сделки", own: true, description: "Разметка своих сделок: сетап, теги, оценки, заметки (сделки приходят из PropReports)." },
  { key: "trades.write.any", group: "Сделки", label: "Править чужие сделки", team: true, description: "Редактировать/переназначать сделки других трейдеров, привязывать их к сетапам и событиям." },
  { key: "trades.review", group: "Сделки", label: "Разбор сделок куратором", team: true, description: "Оставлять разборы (POST /trades/:id/reviews), оценку качества." },
  { key: "trades.review.delete.any", group: "Сделки", label: "Удалять чужие разборы", adminOnly: true, description: "Удалять разборы других кураторов." },

  // ── Journal / review loops ───────────────────────────────────────────────
  { key: "journal.write.own", group: "Дневник", label: "Вести свой дневник", own: true, description: "План дня, итоги дня, закрытие дня, недельная самооценка, заметки, эмоции." },
  { key: "journal.read.team", group: "Дневник", label: "Читать дневники команды", team: true, description: "Дневник, EOD-статус, недельный отчёт, заметки, эмоции и психо-аналитика других трейдеров." },
  { key: "journal.review", group: "Дневник", label: "Ревью куратора", team: true, description: "Очередь закрытых дней, оценка дня, недельный отчёт 1:1, сводки джуниоров, напоминания." },
  { key: "gameplan.publish", group: "Дневник", label: "Публиковать план дня", description: "Создавать/удалять premarket game plan и видеть кто прочитал." },
  { key: "dailyfeed.manage", group: "Дневник", label: "Управлять дневной лентой", team: true, description: "EOD-пост ленты, правка чужих записей, список непрочитавших." },
  { key: "errors.manage.team", group: "Дневник", label: "Журнал ошибок команды", team: true, description: "Смотреть и вести журнал ошибок от имени трейдера." },

  // ── Risk / scaling ───────────────────────────────────────────────────────
  { key: "risk.read.own", group: "Риск", label: "Свой риск-профиль", own: true, description: "Лимиты, история, позиции, алерты по себе." },
  { key: "risk.read.team", group: "Риск", label: "Риск-деск", team: true, description: "/risk/desk, лимиты и история любого трейдера." },
  { key: "risk.limits.edit", group: "Риск", label: "Менять лимиты", team: true, description: "PUT /risk/limits/:trader." },
  { key: "scaling.read.team", group: "Риск", label: "План масштабирования команды", team: true, description: "Оценка и история любого трейдера." },
  { key: "scaling.configure", group: "Риск", label: "Настраивать лестницу тиров", description: "PUT /scaling/tiers и /scaling/rules." },
  { key: "scaling.approve", group: "Риск", label: "Решать по тирам", team: true, description: "Создавать/одобрять/отклонять предложения, назначать тир напрямую." },
  { key: "rules.manage.team", group: "Риск", label: "Правила команды", team: true, description: "Правила и нарушения других трейдеров (просмотр, создание, правка)." },
  { key: "rules.violations.delete", group: "Риск", label: "Удалять нарушения", description: "DELETE /rule-violations/:id (трейдер может только «принять»)." },

  // ── PropReports ──────────────────────────────────────────────────────────
  { key: "propreports.import", group: "PropReports", label: "Импорт своих отчётов", own: true, description: "Загрузка файлов по своим счетам (dry-run и запись)." },
  { key: "propreports.read.team", group: "PropReports", label: "Статус и отчёты команды", team: true, description: "Все счета, история синка, инбокс сверки, отчёты по любому трейдеру." },
  { key: "propreports.configure", group: "PropReports", label: "Привязка счетов", description: "PUT /propreports/accounts, обновление списка счетов." },
  { key: "propreports.sync", group: "PropReports", label: "Синхронизация и сверка", description: "Запуск синка, объединение/разделение сделок, удаление отчётов, XLS-импорт из админки." },

  // ── Ratings ──────────────────────────────────────────────────────────────
  { key: "ratings.read.team", group: "Оценки", label: "Оценки команды", team: true, description: "Еженедельные оценки любого трейдера." },
  { key: "ratings.write", group: "Оценки", label: "Ставить оценки", team: true, description: "POST /ratings, править/удалять свои оценки." },
  { key: "ratings.manage.any", group: "Оценки", label: "Править чужие оценки", adminOnly: true, description: "Редактировать и удалять оценки других кураторов." },

  // ── Playbook / ideas / discussions ───────────────────────────────────────
  { key: "playbook.edit", group: "Контент", label: "Вести плейбук", description: "Создавать сетапы, править свои и командные (без автора)." },
  { key: "playbook.edit.any", group: "Контент", label: "Править чужие сетапы", team: true, description: "Редактировать сетапы, созданные другими трейдерами, автопривязка по всему деску." },
  { key: "playbook.review", group: "Контент", label: "Ревью плейбука", description: "Вердикты approved/needs_work/retired, переименование и удаление папок." },
  { key: "ideas.publish", group: "Контент", label: "Публиковать идеи", own: true, description: "Создавать и публиковать свои торговые идеи, комментировать." },
  { key: "ideas.review", group: "Контент", label: "Ревью идей", team: true, description: "Статус ревью идей, управление чужими идеями, черновики всех." },
  { key: "discussions.moderate", group: "Контент", label: "Модерация обсуждений", description: "Удалять чужие темы и комментарии, закрывать темы." },
  { key: "discussions.edit.any", group: "Контент", label: "Править чужие комментарии", adminOnly: true, description: "Редактировать чужие комментарии." },
  { key: "checklist.template.edit", group: "Контент", label: "Шаблон pre-trade чек-листа", description: "Менять пункты чек-листа для всего деска." },
  { key: "watchlist.manage", group: "Контент", label: "Вотчлист деска", description: "Править общий вотчлист (любой участник, не гость)." },

  // ── Users / admin ────────────────────────────────────────────────────────
  { key: "users.manage", group: "Администрирование", label: "Управлять пользователями", description: "Создавать, править, деактивировать, банить трейдеров и кураторов; менять назначения." },
  { key: "users.manage.admins", group: "Администрирование", label: "Управлять админами", adminOnly: true, description: "Создавать админов, выдавать роль admin, править/деактивировать админов, банить кураторов." },
  { key: "admin.reports", group: "Администрирование", label: "Жалобы на контент", description: "Очередь жалоб, решение, бан автора." },
  { key: "admin.audit", group: "Администрирование", label: "Журнал аудита", description: "Читать audit log и статистику." },
  { key: "admin.backups.read", group: "Администрирование", label: "Список бэкапов", description: "GET /admin/backups, полный JSON-бэкап." },
  { key: "admin.backups.run", group: "Администрирование", label: "Запуск и скачивание бэкапов", adminOnly: true, description: "POST /admin/backups/trigger, ссылки на скачивание." },
  { key: "telegram.broadcast", group: "Администрирование", label: "Telegram-рассылка", description: "Массовая рассылка и отвязка Telegram у пользователей." },
  { key: "digest.manage.any", group: "Администрирование", label: "Дайджест за других", team: true, description: "Смотреть/менять подписку на дайджест другого участника." },
  { key: "permissions.manage", group: "Администрирование", label: "Менять права доступа", adminOnly: true, description: "PUT /permissions/matrix." },
  { key: "admin.errors", group: "Администрирование", label: "Ошибки приложения", adminOnly: true, description: "Пульт → Ошибки: ошибки сервера и браузера, пометка «исправлено»." },
] as const;

export type Capability = (typeof CAPABILITIES)[number]["key"];

export const CAPABILITY_KEYS: readonly Capability[] = CAPABILITIES.map((c) => c.key);
export const CAPABILITY_DEFS: readonly CapabilityDef[] = CAPABILITIES as unknown as readonly CapabilityDef[];
const CAP_BY_KEY = new Map<string, CapabilityDef>(CAPABILITY_DEFS.map((c) => [c.key, c]));

export function capabilityDef(cap: string): CapabilityDef | undefined {
  return CAP_BY_KEY.get(cap);
}
export function isCapability(cap: string): cap is Capability {
  return CAP_BY_KEY.has(cap);
}

/** Own-only capabilities every signed-in member (trader, curator, admin) holds. */
const MEMBER_CAPS: readonly Capability[] = [
  "trades.read.own", "trades.write.own", "journal.write.own", "risk.read.own", "propreports.import",
  "playbook.edit", "ideas.publish", "watchlist.manage",
];

/** Everything a curator may do today (= staff): members' caps + team/review/manage caps minus adminOnly. */
const CURATOR_CAPS: readonly Capability[] = [
  ...MEMBER_CAPS,
  "team.read", "users.read.team",
  "trades.read.team", "trades.write.any", "trades.review",
  "journal.read.team", "journal.review", "gameplan.publish", "dailyfeed.manage", "errors.manage.team",
  "risk.read.team", "risk.limits.edit", "scaling.read.team", "scaling.configure", "scaling.approve",
  "rules.manage.team", "rules.violations.delete",
  "propreports.read.team", "propreports.configure", "propreports.sync",
  "ratings.read.team", "ratings.write",
  "playbook.edit.any", "playbook.review", "ideas.review", "discussions.moderate", "checklist.template.edit",
  "users.manage", "admin.reports", "admin.audit", "admin.backups.read", "telegram.broadcast", "digest.manage.any",
];

export const DEFAULT_MATRIX: Readonly<Record<Role, readonly Capability[]>> = {
  guest: [],
  trader: MEMBER_CAPS,
  curator: CURATOR_CAPS,
  admin: CAPABILITY_KEYS,
};

/** Default scope of every team capability: the whole desk (today's behaviour — assignments only route notifications). */
export const DEFAULT_SCOPE: Scope = "desk";

export type Override = { role: Role; capability: Capability; allowed: boolean; scope?: Scope | null };

export type Grant = { allowed: boolean; scope: Scope };
/** role → capability → effective grant. */
export type EffectiveMatrix = Record<Role, Record<Capability, Grant>>;

/** Apply desk overrides on top of the defaults. Admin and guest rows are locked; adminOnly caps never open up. */
export function buildEffectiveMatrix(overrides: readonly Override[] = []): EffectiveMatrix {
  const out = {} as EffectiveMatrix;
  for (const role of ROLES) {
    const defaults = new Set<Capability>(DEFAULT_MATRIX[role]);
    const row = {} as Record<Capability, Grant>;
    for (const cap of CAPABILITY_KEYS) row[cap] = { allowed: defaults.has(cap), scope: DEFAULT_SCOPE };
    out[role] = row;
  }
  for (const o of overrides) {
    if (!isEditableRole(o.role) || !isCapability(o.capability)) continue;
    const def = CAP_BY_KEY.get(o.capability)!;
    if (def.adminOnly) continue; // never granted below admin
    const cell = out[o.role][o.capability];
    cell.allowed = !!o.allowed;
    if (def.team && (o.scope === "desk" || o.scope === "assigned")) cell.scope = o.scope;
  }
  return out;
}

export function isEditableRole(role: string): role is "trader" | "curator" {
  return role === "trader" || role === "curator";
}

/** The overrides that actually differ from the defaults (what PUT /permissions/matrix stores). */
export function diffFromDefaults(matrix: EffectiveMatrix): Override[] {
  const out: Override[] = [];
  for (const role of ROLES) {
    if (!isEditableRole(role)) continue;
    const defaults = new Set<Capability>(DEFAULT_MATRIX[role]);
    for (const cap of CAPABILITY_KEYS) {
      const cell = matrix[role][cap];
      const def = CAP_BY_KEY.get(cap)!;
      const allowedDiffers = cell.allowed !== defaults.has(cap);
      const scopeDiffers = !!def.team && cell.scope !== DEFAULT_SCOPE;
      if (allowedDiffers || scopeDiffers) out.push({ role, capability: cap, allowed: cell.allowed, scope: def.team ? cell.scope : null });
    }
  }
  return out;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export type Actor = {
  id: number;
  name: string;
  role: Role;
  guest: boolean;
  /** Traders whose assigned curator / risk manager / mentor is this actor (only needed for "assigned" scope). */
  wards: readonly string[];
};

export type Target = {
  /** Owner of the data being read/changed (trader name). */
  trader?: string | null;
};

/**
 * May `actor` exercise `cap` on `target`?
 *  - the role must hold the capability (after overrides);
 *  - `own` caps: target.trader (when given) must be the actor;
 *  - `team` caps with target.trader: scope "desk" → anyone; "assigned" → self or a ward.
 *  Without a target, team caps answer "may this actor act on the desk at all".
 */
export function evaluate(matrix: EffectiveMatrix, actor: Actor | null | undefined, cap: Capability, target?: Target | null): boolean {
  if (!actor) return false;
  const cell = matrix[actor.role]?.[cap];
  if (!cell || !cell.allowed) return false;
  const def = CAP_BY_KEY.get(cap)!;
  const t = target?.trader?.trim() || null;
  if (def.own) return t === null || t === actor.name;
  if (def.team && t !== null && t !== actor.name && cell.scope === "assigned") return actor.wards.includes(t);
  return true;
}

/** Which traders a team-scoped read may return: null = everyone, string[] = only these names, [] = nobody. */
export function readableTraders(matrix: EffectiveMatrix, actor: Actor | null | undefined, cap: Capability): string[] | null {
  if (!actor) return [];
  if (actor.guest) return [];
  const cell = matrix[actor.role]?.[cap];
  if (!cell || !cell.allowed) return [actor.name];
  if (cell.scope === "assigned") return [actor.name, ...actor.wards.filter((w) => w !== actor.name)];
  return null;
}

export function capabilitiesOf(matrix: EffectiveMatrix, role: Role): Capability[] {
  return CAPABILITY_KEYS.filter((c) => matrix[role][c].allowed);
}

export function normalizeRole(role: string | null | undefined): Role {
  return role === "admin" || role === "curator" || role === "guest" ? role : "trader";
}
