import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query } }));

import {
  cancelManualBackupRun,
  claimManualBackupFinalization,
  isBackupRunActive,
  manualBackupRunAccessibleTo,
  saveBackupLiveStatus,
} from "./backup-live-status-store";

describe("manual backup cancellation state transitions", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rowCount: 1, rows: [] });
  });

  it("checks durable producer activity before reclaiming expired stages", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ "?column?": 1 }] });
    expect(await isBackupRunActive("run-id")).toBe(true);
    const [sql, params] = query.mock.calls.find(([statement]) =>
      String(statement).includes("SELECT 1 FROM backup_live_status"))!;
    expect(String(sql)).toContain("state IN ('running', 'finalizing')");
    expect(String(sql)).toContain("run_id = $1::uuid");
    expect(params).toEqual(["run-id"]);

    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await isBackupRunActive("run-id")).toBe(false);
  });

  it("scopes cancellation to the owner and only running or awaiting-delivery runs", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ run_id: "run-id" }] });

    expect(await cancelManualBackupRun("run-id", "owner-id", "session-hash")).toBe("cancelled");
    const call = query.mock.calls.find(([sql]) => String(sql).includes("SET state = 'cancelled'"));
    expect(call).toBeDefined();
    const [sql, params] = call!;
    expect(sql).toContain("requested_by_user_id IS NOT DISTINCT FROM $2");
    expect(sql).toContain("state IN ('running', 'awaiting_verification')");
    expect(sql).toContain("requested_by_session_hash = $3");
    expect(params).toEqual(["run-id", "owner-id", "session-hash"]);
  });

  it("does not expose a manual run to another session of the same user", async () => {
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ requestedByUserId: "owner-id", requestedBySessionHash: "original-session" }],
    });
    expect(await manualBackupRunAccessibleTo("run-id", "owner-id", "original-session")).toBe(true);

    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ requestedByUserId: "owner-id", requestedBySessionHash: "original-session" }],
    });
    expect(await manualBackupRunAccessibleTo("run-id", "owner-id", "other-session")).toBe(false);
  });

  it("does not let finalization claim a cancellation that won the terminal race", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ run_id: "run-id" }] });
    expect(await cancelManualBackupRun("run-id", "owner-id", "session-hash")).toBe("cancelled");

    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await claimManualBackupFinalization("run-id", "owner-id", "session-hash")).toBe(false);
    const finalizationSql = query.mock.calls.find(([sql]) => String(sql).includes("SET state = 'finalizing'"))?.[0] as string;
    expect(finalizationSql).toContain("state = 'awaiting_verification'");
  });

  it("does not allow stale writers to replace a cancelled terminal status", async () => {
    await saveBackupLiveStatus({
      runId: "2cd9aedf-87cf-40f6-8d10-920db0a0aef7",
      state: "running",
      phase: "database dump",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      elapsedMs: 1,
      metrics: {},
    });

    const statusWriteSql = query.mock.calls.find(([sql]) => String(sql).includes("ON CONFLICT (run_id) DO UPDATE SET"))?.[0] as string;
    expect(statusWriteSql).toContain(
      "WHERE backup_live_status.state NOT IN ('completed', 'failed', 'cancelled', 'stale')",
    );
  });
});
