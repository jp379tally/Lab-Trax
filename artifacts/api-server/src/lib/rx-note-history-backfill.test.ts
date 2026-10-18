import { readFileSync } from "node:fs";
import * as path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@workspace/db";

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

const migrationPath = path.resolve(
  process.cwd(),
  "../../lib/db/drizzle/0030_case_rx_note_history.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const backfillStart = migrationSql.indexOf("WITH proven_scan_dates AS (");
if (backfillStart < 0) {
  throw new Error("Rx note history migration is missing the proven-date backfill.");
}
const backfillSql = migrationSql.slice(backfillStart);

describeWithDatabase("Rx note history migration date recovery", () => {
  it("dates only same-case Rx scans with exact, unambiguous submission evidence", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`
        CREATE TEMP TABLE case_rx_note_entries (
          id text PRIMARY KEY,
          case_id text NOT NULL,
          note_text text NOT NULL,
          scanned_at timestamptz,
          provenance text NOT NULL,
          submission_id text,
          created_at timestamptz NOT NULL
        ) ON COMMIT DROP;
      `));
      await tx.execute(sql.raw(`
        CREATE TEMP TABLE case_attachments (
          case_id text,
          submission_id text,
          file_name text NOT NULL,
          file_type text NOT NULL,
          category text,
          deleted_at timestamptz,
          created_at timestamptz NOT NULL
        ) ON COMMIT DROP;
      `));

      await tx.execute(sql.raw(`
        INSERT INTO case_rx_note_entries
          (id, case_id, note_text, scanned_at, provenance, submission_id, created_at)
        VALUES
          ('proved', 'case-a', 'Scan note', NULL, 'ai_reader', 'rx-proof-001',
            '2026-05-04T13:00:00Z'),
          ('sibling', 'case-a', 'Other case scan', NULL, 'ai_reader', 'rx-sibling-001',
            '2026-05-04T13:00:00Z'),
          ('mixed-dates', 'case-a', 'Pages on different dates', NULL, 'ai_reader',
            'rx-mixed-001', '2026-05-06T13:00:00Z'),
          ('deleted', 'case-a', 'Deleted scan page', NULL, 'ai_reader', 'rx-deleted-001',
            '2026-05-04T13:00:00Z'),
          ('late', 'case-a', 'Later attachment', NULL, 'ai_reader', 'rx-late-001',
            '2026-05-04T13:00:00Z'),
          ('wrong-file', 'case-a', 'Filename does not prove a scan', NULL, 'ai_reader',
            'rx-wrong-file-001', '2026-05-04T13:00:00Z'),
          ('outgoing', 'case-a', 'Outgoing photo is not an Rx scan', NULL, 'ai_reader',
            'rx-outgoing-001', '2026-05-04T13:00:00Z'),
          ('legacy', 'case-a', 'Legacy note', NULL, 'legacy', NULL,
            '2026-05-04T13:00:00Z'),
          ('authored', 'case-a', 'Authored note', NULL, 'legacy', 'rx-proof-001',
            '2026-05-04T13:00:00Z'),
          ('intake', 'case-a', 'Case intake note', NULL, 'case_intake', 'rx-proof-001',
            '2026-05-04T13:00:00Z'),
          ('imported', 'case-a', 'Imported note', NULL, 'itero_import', 'rx-proof-001',
            '2026-05-04T13:00:00Z'),
          ('already-dated', 'case-a', 'Existing date', '2026-05-01T10:00:00Z',
            'ai_reader', 'rx-proof-001', '2026-05-04T13:00:00Z');
      `));
      await tx.execute(sql.raw(`
        INSERT INTO case_attachments
          (case_id, submission_id, file_name, file_type, category, deleted_at, created_at)
        VALUES
          ('case-a', 'rx-proof-001:page:a', 'rx-rescan-rx-proof-001:page:a.jpg',
            'image/jpeg', NULL, NULL, '2026-05-04T12:00:00Z'),
          ('case-a', 'rx-proof-001:page:b', 'rx-rescan-rx-proof-001:page:b.jpg',
            'image/jpeg', NULL, NULL, '2026-05-04T12:05:00Z'),
          -- Matching submission ID on a sibling case must not be borrowed.
          ('case-b', 'rx-sibling-001:page:a', 'rx-rescan-rx-sibling-001:page:a.jpg',
            'image/jpeg', NULL, NULL, '2026-05-03T12:00:00Z'),
          ('case-a', 'rx-mixed-001:page:a', 'rx-rescan-rx-mixed-001:page:a.jpg',
            'image/jpeg', NULL, NULL, '2026-05-04T12:00:00Z'),
          ('case-a', 'rx-mixed-001:page:b', 'rx-rescan-rx-mixed-001:page:b.jpg',
            'image/jpeg', NULL, NULL, '2026-05-05T12:00:00Z'),
          ('case-a', 'rx-deleted-001:page:a', 'rx-rescan-rx-deleted-001:page:a.jpg',
            'image/jpeg', NULL, '2026-05-06T12:00:00Z', '2026-05-04T12:00:00Z'),
          ('case-a', 'rx-late-001:page:a', 'rx-rescan-rx-late-001:page:a.jpg',
            'image/jpeg', NULL, NULL, '2026-05-04T14:00:00Z'),
          ('case-a', 'rx-wrong-file-001:page:a', 'photo-rx-wrong-file-001:page:a.jpg',
            'image/jpeg', NULL, NULL, '2026-05-04T12:00:00Z'),
          ('case-a', 'rx-outgoing-001:page:a', 'rx-rescan-rx-outgoing-001:page:a.jpg',
            'image/jpeg', 'outgoing', NULL, '2026-05-04T12:00:00Z'),
          -- An ordinary attachment with a nearby date is not Rx scan evidence.
          ('case-a', NULL, 'unrelated.jpg', 'image/jpeg', NULL, NULL,
            '2026-05-04T12:00:00Z');
      `));

      await tx.execute(sql.raw(backfillSql));
      const result = await tx.execute(sql`
        SELECT id, scanned_at
        FROM case_rx_note_entries
        ORDER BY id
      `);
      const scannedAtById = new Map<string, string | null>(
        (result.rows as Array<{ id: string; scanned_at: Date | string | null }>).map(
          (row) => [
            row.id,
            row.scanned_at == null
              ? null
              : new Date(row.scanned_at).toISOString(),
          ],
        ),
      );

      expect(scannedAtById.get("proved")).toBe("2026-05-04T12:00:00.000Z");
      for (const id of [
        "sibling",
        "mixed-dates",
        "deleted",
        "late",
        "wrong-file",
        "outgoing",
        "legacy",
        "authored",
        "intake",
        "imported",
      ]) {
        expect(scannedAtById.get(id), id).toBeNull();
      }
      expect(scannedAtById.get("already-dated")).toBe("2026-05-01T10:00:00.000Z");
    });
  });
});
