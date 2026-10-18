import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { backupLiveStatus } from "@workspace/db/schema";

describe("backup live status schema", () => {
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
  });
});
