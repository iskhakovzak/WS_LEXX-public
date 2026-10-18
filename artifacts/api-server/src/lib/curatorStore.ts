/**
 * Кабинет куратора — таблицы (идемпотентно, лениво из роутов curator.ts / risk.ts).
 *
 *   curator_notes        приватные заметки персонала о трейдере (трейдер их не видит); мягкое удаление archived_at
 *   risk_breach_reviews  «Разбор нарушения»: причина, договорённости, последствие по записи risk_alert_log (1:1)
 *   curator_queue_acks   мягкий архив элементов очереди разборов («архивировать старые»): исходные записи не трогаются,
 *                        элемент просто скрывается из очереди; отметка с revoked_at ≠ NULL не действует (элемент вернётся)
 */
import { pool } from "@workspace/db";

let ensured: Promise<void> | null = null;

export function ensureCuratorTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS curator_notes (
        id SERIAL PRIMARY KEY,
        trader TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'note',
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at TIMESTAMPTZ,
        archived_by TEXT
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS curator_notes_trader_idx ON curator_notes (trader, created_at DESC) WHERE archived_at IS NULL`);
      await pool.query(`CREATE TABLE IF NOT EXISTS risk_breach_reviews (
        id SERIAL PRIMARY KEY,
        alert_id INTEGER NOT NULL UNIQUE,
        trader TEXT NOT NULL,
        date TEXT NOT NULL,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        comment TEXT,
        actions JSONB NOT NULL DEFAULT '[]'::jsonb,
        consequence TEXT NOT NULL DEFAULT 'none',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at TIMESTAMPTZ,
        archived_by TEXT
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS risk_breach_reviews_trader_idx ON risk_breach_reviews (trader, date DESC)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS curator_queue_acks (
        item_id TEXT PRIMARY KEY,
        trader TEXT NOT NULL,
        kind TEXT NOT NULL,
        acked_by TEXT NOT NULL,
        acked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      )`);
    })().catch((e) => {
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

export type CuratorNote = {
  id: number;
  trader: string;
  author: string;
  body: string;
  kind: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export function rowToNote(r: any): CuratorNote {
  return {
    id: Number(r.id),
    trader: String(r.trader),
    author: String(r.author),
    body: String(r.body),
    kind: String(r.kind ?? "note"),
    pinned: r.pinned === true,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export type BreachReviewRow = {
  id: number;
  alertId: number;
  trader: string;
  date: string;
  kind: string;
  reason: string;
  comment: string | null;
  actions: { id: string; title: string; dueOn: string | null; status: string }[];
  consequence: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
};

export function rowToBreachReview(r: any): BreachReviewRow {
  return {
    id: Number(r.id),
    alertId: Number(r.alert_id),
    trader: String(r.trader),
    date: String(r.date),
    kind: String(r.kind),
    reason: String(r.reason),
    comment: r.comment ?? null,
    actions: Array.isArray(r.actions) ? r.actions : [],
    consequence: String(r.consequence ?? "none"),
    createdBy: String(r.created_by),
    createdAt: new Date(r.created_at).toISOString(),
    updatedBy: r.updated_by ?? null,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
