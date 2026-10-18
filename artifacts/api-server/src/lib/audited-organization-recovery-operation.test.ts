import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  digest: "428da4afe2bbe6ad8f648cd424ce2dae",
  connect: vi.fn(),
}));
vi.mock("@workspace/db", async (original) => ({
  ...await original<typeof import("@workspace/db")>(),
  pool: { connect: harness.connect },
}));
vi.mock("node:crypto", () => ({
  createHash: () => ({ update: () => ({ digest: () => harness.digest }) }),
}));
import { ORGANIZATION_RECOVERY_APPROVAL, runAuditedOrganizationRecovery } from "./audited-organization-recovery-operation";

const candidates = Array.from({ length: 24 }, (_, i) => ({
  organization_id: `synthetic-org-${i}`, audit_id: `synthetic-audit-${i}`,
  action: "organization_created", snapshot_hash: "a".repeat(32),
  snapshot: {
    id: `synthetic-org-${i}`, name: "Synthetic organization", type: "lab",
    isActive: true, deletedAt: null, createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  },
}));

function fixture(options: { unsafe?: boolean; clinical?: boolean; triggers?: boolean; failInsert?: boolean; failReceipt?: boolean; lostCommitResponse?: boolean; failRollback?: boolean } = {}) {
  let pending = 0;
  let committed = 0;
  let receipt = false;
  const query = vi.fn(async (sql: string) => {
    if (sql === "COMMIT") {
      committed += pending; pending = 0; receipt = true;
      if (options.lostCommitResponse) {
        options.lostCommitResponse = false;
        throw new Error("Simulated response loss after commit");
      }
    }
    if (sql === "ROLLBACK") {
      pending = 0;
      if (options.failRollback) throw new Error("Connection lost");
    }
    if (sql.includes("SELECT metadata_json")) return { rows: receipt ? [{ metadata_json: { sourceAuditIds: candidates.map((c) => c.audit_id) } }] : [] };
    if (sql.includes("WITH missing AS") || sql.includes("SELECT entity_id AS organization_id")) return { rows: candidates };
    if (sql.includes("SELECT id FROM public.lab_memberships")) return { rows: candidates.map((_, i) => ({ id: `synthetic-member-${i}` })) };
    if (sql.includes("INSERT INTO public.organizations")) {
      pending++;
      if (options.failInsert && pending === 5) throw new Error("PRIVATE FAILED ROW AND BILLING CONTACT");
    }
    if (sql.includes("INSERT INTO public.audit_logs") && options.failReceipt) throw new Error("PRIVATE AUDIT DIAGNOSTIC");
    let count = "0";
    if (sql.includes("WHERE id=ANY") && sql.includes("count(*)") && sql.includes("public.organizations")) count = committed.toString();
    if (sql.includes("FROM pg_trigger") && options.triggers) count = "1";
    if (sql.includes("WITH c AS") && options.unsafe) count = "1";
    if (sql.includes("SELECT (") && options.clinical) count = "1";
    return { rows: [{ count }] };
  });
  const release = vi.fn();
  harness.connect.mockResolvedValue({ query, release });
  return { query, release, committed: () => committed, pending: () => pending };
}

describe("fixed-scope audited organization operation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.digest = ORGANIZATION_RECOVERY_APPROVAL.digest;
  });
  it("defaults through the route to a read-only assessment and releases its transaction", async () => {
    const f = fixture();
    expect((await runAuditedOrganizationRecovery(true, null)).state).toBe("ready");
    expect(f.query.mock.calls.some(([q]) => q.startsWith("INSERT"))).toBe(false);
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.release).toHaveBeenCalled();
  });
  it("refuses stale evidence before inserting any parent", async () => {
    const f = fixture();
    harness.digest = "b".repeat(32);
    await expect(runAuditedOrganizationRecovery(false, null)).rejects.toThrow("evidence changed");
    expect(f.pending()).toBe(0);
    expect(f.committed()).toBe(0);
  });
  it.each([
    { name: "missing/conflicting dependencies", unsafe: true },
    { name: "new clinical records", clinical: true },
    { name: "new insert triggers", triggers: true },
  ])("refuses $name", async (options) => {
    const f = fixture(options);
    await expect(runAuditedOrganizationRecovery(false, null)).rejects.toThrow();
    expect(f.committed()).toBe(0);
    expect(f.pending()).toBe(0);
  });
  it.each([{ failInsert: true }, { failReceipt: true }])("rolls back partial insertion and required receipt failure", async (options) => {
    const f = fixture(options);
    const error = await runAuditedOrganizationRecovery(false, null).catch((e) => e);
    expect(error.statusCode).toBe(409);
    expect(error.message).not.toContain("PRIVATE");
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.committed()).toBe(0);
    expect(f.pending()).toBe(0);
  });
  it("commits once and replays the receipt without overwriting organization edits", async () => {
    const f = fixture();
    expect((await runAuditedOrganizationRecovery(false, null)).state).toBe("applied");
    expect((await runAuditedOrganizationRecovery(false, null)).state).toBe("already-applied");
    expect(f.committed()).toBe(24);
    expect(f.query.mock.calls.filter(([q]) => q.includes("INSERT INTO public.organizations")).length).toBe(24);
  });
  it("allows 60 seconds only for evidence and resets to 15 before writes", async () => {
    const f = fixture();
    await runAuditedOrganizationRecovery(false, null);
    const sql = f.query.mock.calls.map(([q]) => q);
    const extended = sql.indexOf("SET LOCAL statement_timeout = '60s'");
    const evidence = sql.findIndex((q) => q.includes("WITH missing AS"));
    const reset = sql.indexOf("SET LOCAL statement_timeout = '15s'", extended + 1);
    const membership = sql.findIndex((q) => q.includes("SELECT id FROM public.lab_memberships"));
    const insert = sql.findIndex((q) => q.includes("INSERT INTO public.organizations"));
    expect(extended).toBeGreaterThan(0);
    expect(evidence).toBeGreaterThan(extended);
    expect(reset).toBeGreaterThan(evidence);
    expect(membership).toBeGreaterThan(reset);
    expect(insert).toBeGreaterThan(membership);
    expect(sql.slice(reset + 1).some((q) => q.includes("statement_timeout"))).toBe(false);
  });
  it("sanitizes database connection failures before any transaction", async () => {
    harness.connect.mockRejectedValueOnce(new Error("PRIVATE CONNECTION DETAILS"));
    const error = await runAuditedOrganizationRecovery(false, null).catch((e) => e);
    expect(error.statusCode).toBe(503);
    expect(error.message).not.toContain("PRIVATE");
  });
  it("resolves an ambiguous commit from its durable receipt rather than re-inserting", async () => {
    const f = fixture({ lostCommitResponse: true });
    await expect(runAuditedOrganizationRecovery(false, null)).rejects.toThrow("receipt");
    expect((await runAuditedOrganizationRecovery(false, null)).state).toBe("already-applied");
    expect(f.committed()).toBe(24);
  });
  it("discards a connection that cannot be rolled back", async () => {
    const f = fixture({ failRollback: true });
    harness.digest = "b".repeat(32);
    await expect(runAuditedOrganizationRecovery(false, null)).rejects.toThrow("evidence changed");
    expect(f.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
