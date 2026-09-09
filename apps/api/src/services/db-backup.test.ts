import { describe, expect, it } from "vitest";
import {
  backupKeyFor,
  selectForDeletion,
  shouldRunBackup,
} from "./db-backup.js";
import type { R2Object } from "./r2.js";

const obj = (iso: string): R2Object => ({
  key: `smm/db/smm-${iso}.sql.gz.gpg`,
  size: 1024,
  lastModified: new Date(iso),
});

describe("shouldRunBackup", () => {
  const now = new Date("2026-09-09T12:00:00.000Z");

  it("runs when there has never been a backup", () => {
    expect(shouldRunBackup(null, now)).toBe(true);
  });

  it("runs when the newest backup is older than the interval", () => {
    expect(shouldRunBackup(new Date("2026-09-08T12:00:00.000Z"), now)).toBe(true);
  });

  it("waits when a backup was taken recently", () => {
    expect(shouldRunBackup(new Date("2026-09-09T06:00:00.000Z"), now)).toBe(false);
  });

  // 23h rather than 24h on purpose: a strict 24h check plus any tick jitter
  // means a daily job slowly drifts and eventually skips a calendar day.
  it("uses a 23h threshold so a daily cadence cannot drift into skipping a day", () => {
    const at23h = new Date(now.getTime() - 23 * 3_600_000);
    expect(shouldRunBackup(at23h, now)).toBe(true);
    const at22h59 = new Date(now.getTime() - (23 * 3_600_000 - 60_000));
    expect(shouldRunBackup(at22h59, now)).toBe(false);
  });
});

describe("backupKeyFor", () => {
  it("builds a sortable, prefixed key", () => {
    expect(backupKeyFor(new Date("2026-09-09T12:34:56.789Z"))).toBe(
      "smm/db/smm-20260909T123456Z.sql.gz.gpg"
    );
  });

  it("sorts lexicographically in chronological order", () => {
    const keys = [
      backupKeyFor(new Date("2026-09-10T01:00:00Z")),
      backupKeyFor(new Date("2026-09-09T23:00:00Z")),
      backupKeyFor(new Date("2026-10-01T00:00:00Z")),
    ];
    expect([...keys].sort()).toEqual([keys[1], keys[0], keys[2]]);
  });
});

describe("selectForDeletion", () => {
  it("keeps everything when there is less than the retention window", () => {
    const objects = [obj("2026-09-09T02:00:00Z"), obj("2026-09-08T02:00:00Z")];
    expect(selectForDeletion(objects)).toEqual([]);
  });

  it("keeps only the newest backup from a day with several", () => {
    const morning = obj("2026-09-09T02:00:00Z");
    const evening = obj("2026-09-09T20:00:00Z");
    const deleted = selectForDeletion([morning, evening]);
    expect(deleted.map((o) => o.key)).toEqual([morning.key]);
  });

  it("keeps 7 dailies and drops the 8th day", () => {
    // 10 consecutive days, one backup each.
    const objects = Array.from({ length: 10 }, (_, i) =>
      obj(`2026-09-${String(20 - i).padStart(2, "0")}T02:00:00Z`)
    );
    const deleted = selectForDeletion(objects, { daily: 7, weekly: 0 });
    expect(deleted).toHaveLength(3);
    // The three oldest go.
    expect(deleted.map((o) => o.lastModified.toISOString().slice(0, 10))).toEqual([
      "2026-09-13",
      "2026-09-12",
      "2026-09-11",
    ]);
  });

  // The point of grandfather-father-son: an old backup that is the sole
  // survivor of its week must outlive the 7-day daily window.
  it("keeps a weekly even when it falls outside the daily window", () => {
    const recent = Array.from({ length: 7 }, (_, i) =>
      obj(`2026-09-${String(20 - i).padStart(2, "0")}T02:00:00Z`)
    );
    const old = obj("2026-08-25T02:00:00Z"); // several weeks back
    const deleted = selectForDeletion([...recent, old], { daily: 7, weekly: 4 });
    expect(deleted.map((o) => o.key)).not.toContain(old.key);
  });

  it("drops an old backup once enough newer weeks exist to fill the quota", () => {
    const weeklies = [
      obj("2026-09-14T02:00:00Z"),
      obj("2026-09-07T02:00:00Z"),
      obj("2026-08-31T02:00:00Z"),
      obj("2026-08-24T02:00:00Z"),
    ];
    const ancient = obj("2025-01-01T02:00:00Z");
    const deleted = selectForDeletion([...weeklies, ancient], { daily: 0, weekly: 4 });
    expect(deleted.map((o) => o.key)).toEqual([ancient.key]);
  });

  // Retention counts the weeks actually present, newest first — not the last N
  // calendar weeks. With a sparse history that means an old backup is KEPT
  // rather than deleted, which is the right direction to err for a backup:
  // deleting the only historical copy to satisfy a calendar rule is worse than
  // holding one extra object.
  it("keeps an old backup while the weekly quota is unfilled", () => {
    const oneWeek = Array.from({ length: 7 }, (_, i) =>
      obj(`2026-09-${String(20 - i).padStart(2, "0")}T02:00:00Z`)
    );
    const ancient = obj("2025-01-01T02:00:00Z");
    const deleted = selectForDeletion([...oneWeek, ancient], { daily: 7, weekly: 4 });
    expect(deleted).toEqual([]);
  });

  it("never deletes the only backup that exists", () => {
    expect(selectForDeletion([obj("2020-01-01T00:00:00Z")])).toEqual([]);
  });

  it("returns nothing for an empty bucket", () => {
    expect(selectForDeletion([])).toEqual([]);
  });

  // Week bucketing runs Monday-to-Sunday; a naive "divide by 7 days" bucket
  // would put these two in the same week and delete one.
  it("treats a Sunday and the following Monday as different weeks", () => {
    const sunday = obj("2026-09-13T02:00:00Z");
    const monday = obj("2026-09-14T02:00:00Z");
    const filler = Array.from({ length: 7 }, (_, i) =>
      obj(`2026-09-${String(21 + i).padStart(2, "0")}T02:00:00Z`)
    );
    const deleted = selectForDeletion([sunday, monday, ...filler], {
      daily: 7,
      weekly: 4,
    });
    const deletedKeys = deleted.map((o) => o.key);
    expect(deletedKeys).not.toContain(sunday.key);
    expect(deletedKeys).not.toContain(monday.key);
  });
});
