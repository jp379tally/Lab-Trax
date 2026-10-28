import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ query: vi.fn(), owner: null as null | { requested_by_user_id: string | null; requested_by_session_hash: string; state: string } }));
vi.mock("@workspace/db", () => ({ pool: { query: fake.query } }));
import { reconnectManualBackupSession, manualBackupRunAccessibleTo, cancelManualBackupRun } from "./backup-live-status-store";
beforeEach(() => {
  fake.owner = { requested_by_user_id: "owner", requested_by_session_hash: "old-session", state: "running" };
  fake.query.mockReset();
  fake.query.mockImplementation(async (sql: string, params?: string[]) => {
    if (sql.startsWith("UPDATE backup_live_status SET requested_by_session_hash")) {
      if (fake.owner && fake.owner.requested_by_user_id === params![1]) {
        fake.owner.requested_by_session_hash = params![2]; return { rowCount: 1, rows: [{ run_id: params![0] }] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("SET state = 'cancelled'")) {
      if (fake.owner?.requested_by_user_id === params![1] && fake.owner.requested_by_session_hash === params![2] && fake.owner.state === "running") {
        fake.owner.state = "cancelled"; return { rowCount: 1, rows: [{ run_id: params![0] }] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (sql.trimStart().startsWith("SELECT")) return { rowCount: fake.owner ? 1 : 0, rows: fake.owner ? [{ ...fake.owner,
      requestedByUserId: fake.owner.requested_by_user_id, requestedBySessionHash: fake.owner.requested_by_session_hash }] : [] };
    return { rowCount: 0, rows: [] };
  });
});
describe("explicit manual backup session recovery", () => {
  it("keeps ordinary reads private until the same owner explicitly reconnects", async () => {
    expect(await manualBackupRunAccessibleTo("run", "owner", "new-session")).toBe(false);
    expect(await reconnectManualBackupSession("run", "owner", "new-session")).toBe("reconnected");
    expect(await manualBackupRunAccessibleTo("run", "owner", "new-session")).toBe(true);
    expect(await cancelManualBackupRun("run", "owner", "new-session")).toBe("cancelled");
    expect(fake.owner?.state).toBe("cancelled");
  });
  it("does not reassign another administrator's backup", async () => {
    expect(await reconnectManualBackupSession("run", "other-admin", "new-session")).toBe("forbidden");
    expect(fake.owner?.requested_by_session_hash).toBe("old-session");
  });
  it("distinguishes an expired or pruned run from a permission denial", async () => {
    fake.owner = null;
    expect(await reconnectManualBackupSession("old-run", "owner", "new-session")).toBe("not_found");
  });
  it("does not claim absence when database access fails", async () => {
    fake.query.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(reconnectManualBackupSession("run", "owner", "new-session")).rejects.toThrow("database unavailable");
  });
  it("does not let a shared secret take over a user-owned run", async () => {
    expect(await reconnectManualBackupSession("run", null, "shared-secret")).toBe("forbidden");
    expect(fake.owner?.requested_by_session_hash).toBe("old-session");
  });
  it("retains the original shared-secret session without widening access", async () => {
    fake.owner!.requested_by_user_id = null;
    expect(await reconnectManualBackupSession("run", null, "old-session")).toBe("reconnected");
    expect(await reconnectManualBackupSession("run", null, "different-secret")).toBe("forbidden");
  });
});
