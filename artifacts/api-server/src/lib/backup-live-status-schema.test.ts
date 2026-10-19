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
      "elapsed_ms",
      "metrics",
      "phase",
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
    expect(runtimeSql).not.toMatch(/\b(drop|truncate|delete|update)\b/);
  });

  it("declares the table in the migration chain without destructive operations", () => {
    const migration = normalizeSql(readFileSync(migrationPath, "utf8"));
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
    for (const column of getTableConfig(backupLiveStatus).columns) {
      expect(migration).toContain(column.name);
    }
    expect(migration).not.toMatch(/\b(drop|truncate|delete|update)\b/);
    const migrationEntry = journal.entries.find(
      ({ tag }) => tag === "0032_backup_live_status",
    );
    expect(migrationEntry).toMatchObject({
      idx: 31,
      tag: "0032_backup_live_status",
    });
    expect(migration).toBe(normalizeSql(BACKUP_LIVE_STATUS_SCHEMA_SQL));
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
