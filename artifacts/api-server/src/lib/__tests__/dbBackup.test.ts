import { describe, expect, it } from "vitest";
import { backupsToDelete, parsePgDumpMajor } from "../dbBackupCron";

describe("backup retention (14 daily + 8 weekly, NY calendar)", () => {
  it("keeps the newest backup per day for 14 days and per week for 8 weeks", () => {
    const items: { objectName: string; createdAt: string }[] = [];
    // 70 days of nightly backups at 03:15 NY (07:15Z in summer) + an extra manual one today
    for (let i = 0; i < 70; i++) {
      const d = new Date(Date.UTC(2026, 9, 17, 7, 15) - i * 86_400_000);
      items.push({ objectName: `b${i}`, createdAt: d.toISOString() });
    }
    items.push({ objectName: "manual-today", createdAt: "2026-10-17T15:00:00Z" });
    const del = backupsToDelete(items);
    const kept = items.filter((i) => !del.includes(i));
    // 14 days (today's newest = manual) + weekly survivors beyond the daily window
    expect(kept.some((k) => k.objectName === "manual-today")).toBe(true);
    expect(kept.some((k) => k.objectName === "b0")).toBe(false); // older backup of the same day
    expect(kept.length).toBeGreaterThanOrEqual(14);
    expect(kept.length).toBeLessThanOrEqual(14 + 8);
    const weeks = new Set(kept.map((k) => k.createdAt.slice(0, 10)));
    expect(weeks.size).toBe(kept.length);
    expect(kept.every((k) => Date.parse(k.createdAt) > Date.parse("2026-08-20T00:00:00Z"))).toBe(true);
  });

  it("parses pg_dump versions", () => {
    expect(parsePgDumpMajor("pg_dump (PostgreSQL) 16.4")).toBe(16);
    expect(parsePgDumpMajor("pg_dump (PostgreSQL) 17.2 (Debian 17.2-1.pgdg120+1)")).toBe(17);
  });
});
