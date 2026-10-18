/**
 * Discussions audience: token parsing, the read rule (canSeeThread) and its SQL twin (audienceSql).
 * The SQL parity block runs read-only SELECTs over a VALUES(...) CTE aliased `d` and skips when the local
 * Postgres (TEST_DATABASE_URL, default postgresql://postgres:postgres@localhost:5432/edge_tracker_test) is down.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  ANONYMOUS_VIEWER, audienceLabel, audienceOf, audienceSql, canSeeThread, cohortOf, inAudience, isPublicAudience,
  parseAudience, pickStage, viewerTokens, type AudienceViewer,
} from "../discussionAudience";

const junior: AudienceViewer = { name: "Артур", guest: false, moderator: false, staff: false, stage: "junior", cohorts: [1] };
const trainee: AudienceViewer = { name: "Закир", guest: false, moderator: false, staff: false, stage: "trainee", cohorts: [1] };
const remoteTrainee: AudienceViewer = { name: "Умид", guest: false, moderator: false, staff: false, stage: "trainee", cohorts: [2] };
const noStage: AudienceViewer = { name: "Новичок", guest: false, moderator: false, staff: false, stage: null, cohorts: [] };
const curator: AudienceViewer = { name: "Антон", guest: false, moderator: true, staff: true, stage: null, cohorts: [] };
/** Staff role without the moderation capability (desk override) — matches «Кураторам» only. */
const staffNoMod: AudienceViewer = { name: "Тимур", guest: false, moderator: false, staff: true, stage: null, cohorts: [] };
const guest: AudienceViewer = { ...ANONYMOUS_VIEWER, name: "Гость", guest: true };
/** A guest token reusing a member's name must not pass the authorship rule. */
const guestNamedLikeAuthor: AudienceViewer = { ...guest, name: "Закир" };

const VIEWERS = { junior, trainee, remoteTrainee, noStage, curator, staffNoMod, guest, guestNamedLikeAuthor, anon: ANONYMOUS_VIEWER };

type Row = { id: number; trader: string | null; audience: string[] | null };
const ROWS: Row[] = [
  { id: 1, trader: "Ориф", audience: null },
  { id: 2, trader: "Ориф", audience: [] },
  { id: 3, trader: "Ориф", audience: ["junior"] },
  { id: 4, trader: "Ориф", audience: ["trainee", "junior"] },
  { id: 5, trader: "Закир", audience: ["senior"] },
  { id: 6, trader: "Ориф", audience: ["staff"] },
  { id: 7, trader: "Антон", audience: ["cohort:2"] },
  { id: 8, trader: "Антон", audience: ["cohort:1", "senior"] },
  { id: 9, trader: null, audience: ["trader"] },
];

describe("parseAudience", () => {
  it("absent / all / empty → everyone", () => {
    for (const v of [undefined, null, "", "all", ["all"], [], ["junior", "all"], " , "]) {
      expect(parseAudience(v)).toEqual({ ok: true, audience: [] });
    }
  });

  it("canonical order, dedupe, case-insensitive, comma strings", () => {
    expect(parseAudience(["cohort:2", "Staff", "senior", "trainee", "senior"])).toEqual({ ok: true, audience: ["trainee", "senior", "staff", "cohort:2"] });
    expect(parseAudience("junior, trader")).toEqual({ ok: true, audience: ["junior", "trader"] });
    expect(parseAudience(["cohort:10", "cohort:2"])).toEqual({ ok: true, audience: ["cohort:2", "cohort:10"] });
  });

  it("rejects unknown tokens instead of widening to everyone", () => {
    for (const v of ["juniors", ["curators"], ["cohort:0"], ["cohort:-1"], ["cohort:abc"], ["cohort:1 OR 1=1"], 42, { a: 1 }]) {
      expect(parseAudience(v).ok).toBe(false);
    }
  });

  it("caps the number of groups", () => {
    const many = Array.from({ length: 13 }, (_, i) => `cohort:${i + 1}`);
    expect(parseAudience(many).ok).toBe(false);
  });
});

describe("tokens and labels", () => {
  it("cohortOf / audienceOf / isPublicAudience", () => {
    expect(cohortOf("cohort:7")).toBe(7);
    expect(cohortOf("junior")).toBeNull();
    expect(audienceOf(null)).toEqual([]);
    expect(audienceOf(["junior", null, ""])).toEqual(["junior"]);
    expect(isPublicAudience(null)).toBe(true);
    expect(isPublicAudience([])).toBe(true);
    expect(isPublicAudience(["staff"])).toBe(false);
  });

  it("viewer tokens: stage, staff, cohorts; guests have none", () => {
    expect(viewerTokens(junior)).toEqual(["junior", "cohort:1"]);
    expect(viewerTokens(curator)).toEqual(["staff"]);
    expect(viewerTokens({ ...guest, stage: "senior", staff: true, cohorts: [1] })).toEqual([]);
  });

  it("labels in dative, cohorts by name", () => {
    expect(audienceLabel([])).toBe("Всем");
    expect(audienceLabel(["junior", "trader"])).toBe("Джунам, Трейдерам");
    expect(audienceLabel(["staff", "cohort:1", "cohort:9"], new Map([[1, "Офис — осень 2026"]]))).toBe("Кураторам, Офис — осень 2026, Когорта #9");
  });

  it("stage precedence: approved transfer → enrollment → scaling tier", () => {
    expect(pickStage("trader", "junior", "trainee")).toBe("trader");
    expect(pickStage(null, "junior", "trainee")).toBe("junior");
    expect(pickStage(undefined, "bogus", "trainee")).toBe("trainee");
    expect(pickStage(null, null, "lead")).toBeNull();
  });
});

describe("canSeeThread", () => {
  it("public threads: everyone, including guests and anonymous", () => {
    for (const v of Object.values(VIEWERS)) {
      expect(canSeeThread(v, ROWS[0])).toBe(true);
      expect(canSeeThread(v, ROWS[1])).toBe(true);
    }
  });

  it("stage audience", () => {
    expect(canSeeThread(junior, ROWS[2])).toBe(true);
    expect(canSeeThread(trainee, ROWS[2])).toBe(false);
    expect(canSeeThread(trainee, ROWS[3])).toBe(true);
    expect(canSeeThread(noStage, ROWS[3])).toBe(false);
  });

  it("the author always sees their own thread (even outside its audience)", () => {
    expect(canSeeThread(trainee, ROWS[4])).toBe(true);
    expect(canSeeThread(junior, ROWS[4])).toBe(false);
  });

  it("curators: moderators see everything; the staff token alone opens «Кураторам»", () => {
    for (const r of ROWS) expect(canSeeThread(curator, r)).toBe(true);
    expect(canSeeThread(staffNoMod, ROWS[5])).toBe(true);
    expect(canSeeThread(staffNoMod, ROWS[2])).toBe(false);
    expect(canSeeThread(junior, ROWS[5])).toBe(false);
  });

  it("cohort audience", () => {
    expect(canSeeThread(remoteTrainee, ROWS[6])).toBe(true);
    expect(canSeeThread(trainee, ROWS[6])).toBe(false);
    expect(canSeeThread(junior, ROWS[7])).toBe(true);
    expect(canSeeThread(remoteTrainee, ROWS[7])).toBe(false);
  });

  it("guests / anonymous never see restricted threads, even with an author's name", () => {
    for (const v of [guest, guestNamedLikeAuthor, ANONYMOUS_VIEWER]) {
      for (const r of ROWS.slice(2)) expect(canSeeThread(v, r)).toBe(false);
    }
  });

  it("inAudience ignores authorship and moderation (notification fan-out)", () => {
    expect(inAudience(curator, ["junior"])).toBe(false);
    expect(inAudience(curator, ["staff"])).toBe(true);
    expect(inAudience(junior, [])).toBe(true);
  });
});

// ─── SQL parity ─────────────────────────────────────────────────────────────

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

async function probe(): Promise<Pool | null> {
  try {
    const mod = await import("@workspace/db");
    const pool = mod.pool as unknown as Pool;
    await Promise.race([pool.query("SELECT 1"), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    return pool;
  } catch (e) {
    console.warn(`[discussionAudience] Postgres unavailable, SQL parity skipped: ${(e as Error).message}`);
    return null;
  }
}

const pool = await probe();
afterAll(async () => { await pool?.end(); });

const lit = (v: string | null) => (v == null ? "NULL::text" : `'${v.replace(/'/g, "''")}'::text`);
const arr = (a: string[] | null) => (a == null ? "NULL::text[]" : `ARRAY[${a.map(lit).join(",")}]::text[]`);
const valuesCte = `WITH d(id, trader, audience) AS (VALUES ${ROWS.map((r) => `(${r.id}, ${lit(r.trader)}, ${arr(r.audience)})`).join(", ")})`;

describe.skipIf(!pool)("audienceSql ≡ canSeeThread", () => {
  it("every viewer × every row gives the same answer", async () => {
    for (const [label, v] of Object.entries(VIEWERS)) {
      const params: unknown[] = [];
      const where = audienceSql(v, (x) => { params.push(x); return `$${params.length}`; });
      const { rows } = await pool!.query(`${valuesCte} SELECT id FROM d WHERE ${where} ORDER BY id`, params);
      const sqlIds = rows.map((r) => Number(r.id));
      const jsIds = ROWS.filter((r) => canSeeThread(v, r)).map((r) => r.id);
      expect(sqlIds, label).toEqual(jsIds);
    }
  });

  it("values are bound as parameters (no interpolation of names)", () => {
    const params: unknown[] = [];
    const sql = audienceSql({ ...junior, name: "x'); DROP TABLE users; --" }, (x) => { params.push(x); return `$${params.length}`; });
    expect(sql).not.toContain("DROP");
    expect(params).toContain("x'); DROP TABLE users; --");
    expect(audienceSql(curator, () => { throw new Error("no params for moderators"); })).toBe("TRUE");
  });
});
