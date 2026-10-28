import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { backupLiveStatus } from "@workspace/db/schema";
import { BACKUP_LIVE_STATUS_SCHEMA_SQL } from "./backup-live-status-store";

const normalizeSql = (sql: string): string =>
  sql.toLowerCase().replace(/\s+/g, " ").trim();

describe("backup live status schema", () => {
  const migrationPath = resolve(
    import.meta.dirname,
    "../../../../lib/db/drizzle/0032_backup_live_status.sql",
  );
  const fingerprintMigrationPath = resolve(
    import.meta.dirname,
    "../../../../lib/db/drizzle/0033_backup_live_status_request_fingerprint.sql",
  );
  const manualBackupMigrationPath = resolve(
    import.meta.dirname,
    "../../../../lib/db/drizzle/0034_manual_backup_cancel_and_delivery.sql",
  );
  const journalPath = resolve(
    import.meta.dirname,
    "../../../../lib/db/drizzle/meta/_journal.json",
  );
  const startupPath = resolve(import.meta.dirname, "../index.ts");

  it("keeps the runtime-created table and verification evidence in the shared schema", () => {
    const table = getTableConfig(backupLiveStatus);

    expect(table.name).toBe("backup_live_status");
    expect(table.columns.map((column) => column.name).sort()).toEqual([
      "archive_evidence",
      "created_at",
      "delivery",
      "elapsed_ms",
      "metrics",
      "phase",
      "request_fingerprint",
      "requested_by_session_hash",
      "requested_by_user_id",
      "run_id",
      "started_at",
      "state",
      "updated_at",
    ]);
    expect(table.checks).toHaveLength(2);
    expect(table.indexes.map((index) => index.config.name)).toContain(
      "backup_live_status_created_at_idx",
    );

    const runtimeSql = normalizeSql(BACKUP_LIVE_STATUS_SCHEMA_SQL);
    for (const column of table.columns) {
      expect(runtimeSql).toContain(column.name);
    }
    expect(runtimeSql).toContain(
      "alter table backup_live_status add column if not exists archive_evidence jsonb",
    );
    expect(runtimeSql).toContain(
      "alter table backup_live_status add column if not exists request_fingerprint text",
    );
    expect(runtimeSql).not.toMatch(/\b(drop\s+table|truncate|delete|update)\b/);
  });

  it("declares the table in the migration chain without destructive operations", () => {
    const migration = normalizeSql(readFileSync(migrationPath, "utf8"));
    const fingerprintMigration = normalizeSql(
      readFileSync(fingerprintMigrationPath, "utf8"),
    );
    const manualBackupMigration = normalizeSql(
      readFileSync(manualBackupMigrationPath, "utf8"),
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(migration).toContain(
      "create table if not exists backup_live_status",
    );
    expect(migration).toContain(
      "alter table backup_live_status add column if not exists archive_evidence jsonb",
    );
    expect(migration).toContain(
      "create index if not exists backup_live_status_created_at_idx",
    );
    expect(fingerprintMigration).toContain(
      "alter table backup_live_status add column if not exists request_fingerprint text",
    );
    const migrationChain = normalizeSql(`${migration} ${fingerprintMigration} ${manualBackupMigration}`);
    for (const column of getTableConfig(backupLiveStatus).columns) {
      expect(migrationChain).toContain(column.name);
    }
    expect(migration).not.toMatch(/\b(drop|truncate|delete|update)\b/);
    expect(fingerprintMigration).not.toMatch(
      /\b(drop|truncate|delete|update)\b/,
    );
    expect(manualBackupMigration).toContain("requested_by_user_id");
    expect(manualBackupMigration).toContain("requested_by_session_hash");
    expect(manualBackupMigration).toContain("delivery jsonb");
    expect(manualBackupMigration).toContain("'cancelled'");
    expect(manualBackupMigration).not.toMatch(/\b(drop\s+table|truncate|delete|update)\b/);
    const migrationEntry = journal.entries.find(
      ({ tag }) => tag === "0032_backup_live_status",
    );
    expect(migrationEntry).toMatchObject({
      idx: 31,
      tag: "0032_backup_live_status",
    });
    const fingerprintMigrationEntry = journal.entries.find(
      ({ tag }) => tag === "0033_backup_live_status_request_fingerprint",
    );
    expect(fingerprintMigrationEntry).toMatchObject({
      idx: 32,
      tag: "0033_backup_live_status_request_fingerprint",
    });
    expect(journal.entries.find(({ tag }) => tag === "0034_manual_backup_cancel_and_delivery"))
      .toMatchObject({ idx: 33, tag: "0034_manual_backup_cancel_and_delivery" });
  });

  it("opens the API listener before best-effort schema initialization", () => {
    const startup = readFileSync(startupPath, "utf8");
    const listenAt = startup.indexOf("const server = app.listen");
    const schemaSetupAt = startup.indexOf("ensureBackupLiveStatusSchema().catch");

    expect(listenAt).toBeGreaterThanOrEqual(0);
    expect(schemaSetupAt).toBeGreaterThan(listenAt);
    expect(startup).toContain("server still running");
  });
});
