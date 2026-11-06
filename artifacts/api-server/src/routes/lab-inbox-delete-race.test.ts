import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hermetic route regression: the committed row changes after an earlier read.
// Only the SELECT ... FOR UPDATE view may authorize deletion or assignment.
const h = vi.hoisted(() => ({
  row: {} as any,
  race: false,
  failDelete: false,
  operations: [] as string[],
  selectionSql: [] as string[],
  authorize: vi.fn(),
  copy: vi.fn(),
  remove: vi.fn(),
  move: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@workspace/db", async () => {
  const { pgTable, text, timestamp, PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const labInboxFiles = pgTable("lab_inbox_files", {
    id: text("id"), labOrganizationId: text("lab_organization_id"),
    assignedAt: timestamp("assigned_at"), assignedToCaseId: text("assigned_to_case_id"),
  });
  const cases = pgTable("cases", { id: text("id"), deletedAt: timestamp("deleted_at") });
  const organizations = pgTable("organizations", { id: text("id"), type: text("type"), deletedAt: timestamp("deleted_at") });
  const users = pgTable("users", { id: text("id") });
  function staleRow() {
    const snapshot = { ...h.row };
    if (h.race) {
      h.row.assignedAt = new Date();
      h.row.assignedToCaseId = "case-existing";
    }
    return snapshot;
  }
  const removeRow = () => {
    h.operations.push("delete-row");
    if (h.failDelete) throw new Error("Synthetic database failure");
    const deleted = h.row ? [{ id: h.row.id }] : [];
    h.row = null;
    return deleted;
  };
  const tx = {
    select: () => {
      let table: unknown;
      let predicate = "";
      const chain = {
        from: (value: unknown) => { table = value; return chain; },
        where: (value: any) => { predicate = dialect.sqlToQuery(value).sql; h.selectionSql.push(predicate); return chain; },
        orderBy: () => { h.operations.push("ordered-lock"); return chain; },
        for: async (mode: string) => {
          expect(mode).toBe("update");
          if (table === cases) { h.operations.push("case-lock"); return [{ id: "case-new", labOrganizationId: "lab-a" }]; }
          h.operations.push("inbox-lock");
          // A concurrent assign commits before this request obtains the lock.
          if (h.race) { h.row.assignedAt = new Date(); h.row.assignedToCaseId = "case-existing"; }
          if (!h.row || (predicate.includes('"assigned_at" is null') && h.row.assignedAt)) return [];
          return [{ ...h.row }];
        },
      };
      return chain;
    },
    delete: () => ({ where: () => ({ then: (resolve: any, reject: any) => Promise.resolve().then(removeRow).then(resolve, reject), returning: async () => removeRow() }) }),
    query: { labInboxFiles: { findFirst: async () => staleRow() } },
  };
  h.transaction.mockImplementation(async (work: any) => {
    const saved = structuredClone(h.row);
    h.operations.push("begin");
    try { const result = await work(tx); h.operations.push("commit"); return result; }
    catch (error) { h.row = saved; h.operations.push("rollback"); throw error; }
  });
  return {
    labInboxFiles, cases, organizations, users,
    caseAttachments: {}, caseEvents: {}, notifications: {}, organizationMemberships: {},
    db: {
      transaction: h.transaction,
      delete: tx.delete,
      query: {
        labInboxFiles: { findFirst: async () => staleRow(), findMany: async () => [staleRow()] },
        organizations: { findFirst: async () => ({ id: "lab-a", type: "lab" }) },
        users: { findFirst: async () => ({ id: "fixture-user", username: "synthetic" }) },
        cases: { findFirst: async () => ({ id: "case-new", labOrganizationId: "lab-a" }) },
      },
    },
  };
});
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: () => true, mkdirSync: vi.fn() }));
vi.mock("../middlewares/auth", () => ({ requireAuth: (req: any, res: any, next: any) => {
  if (req.get("Authorization") !== "Bearer fixture-user") return res.status(401).json({ ok: false });
  req.auth = { userId: "fixture-user" }; next();
} }));
vi.mock("../lib/rbac", () => ({ requireMembership: h.authorize }));
vi.mock("../lib/soft-delete", async () => {
  const { isNull } = await import("drizzle-orm");
  return { notDeleted: (table: any) => isNull(table.deletedAt) };
});
vi.mock("../lib/lab-inbox-storage-repair", () => ({ normalizeInboxStorageName: (value: string | null) => value && /^[a-z0-9._-]+$/i.test(value) && !value.includes("..") ? value : null }));
vi.mock("../lib/production-media-multipart", () => ({ productionMediaDiskStorage: () => ({ _handleFile: vi.fn(), _removeFile: vi.fn() }) }));
vi.mock("../lib/production-media-local-write", () => ({ copyProductionUpload: h.copy, deleteProductionUpload: h.remove, moveProductionUpload: h.move, writeProductionUpload: vi.fn() }));
vi.mock("../lib/cross-lab-doctor", () => ({ getProviderOrgIdsForUserAndLinks: vi.fn() }));
vi.mock("../lib/case-media-object-storage", () => ({ caseMediaObjectStorageAvailable: () => false, caseMediaObjectStorageKeyExists: vi.fn(), openCaseMediaObjectStream: vi.fn(), writeCaseMediaToObjectStorage: vi.fn() }));
vi.mock("../lib/in-app-notifications", () => ({ deliverInAppNotification: vi.fn() }));
vi.mock("../lib/provider-capabilities", () => ({ assertProviderCapability: vi.fn() }));
vi.mock("../lib/entitlement-write-guard", () => ({ assertOrganizationMutationAllowed: vi.fn() }));
vi.mock("./lab-inbox-intake", async () => {
  const { Router } = await import("express");
  return { createLabInboxIntakeRouter: () => Router() };
});

import router from "./lab-inbox";

function app() {
  const instance = express(); instance.use(express.json()); instance.use("/api/lab-inbox", router);
  instance.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode ?? 500).json({ ok: false }));
  return instance;
}
const deletion = (bulk = false, authenticated = true) => {
  const call = request(app()).delete(`/api/lab-inbox/${bulk ? "" : "doc-a"}`);
  if (authenticated) call.set("Authorization", "Bearer fixture-user");
  return bulk ? call.send({ fileIds: ["doc-a"], labOrganizationId: "lab-a" }) : call;
};

describe("inbox deletion and assignment interlock", () => {
  beforeEach(() => {
    vi.clearAllMocks(); h.operations.length = 0; h.selectionSql.length = 0; h.race = false; h.failDelete = false;
    h.row = { id: "doc-a", labOrganizationId: "lab-a", storagePath: "synthetic.pdf", originalFilename: "synthetic.pdf", assignedAt: null, assignedToCaseId: null };
    h.authorize.mockResolvedValue({ role: "admin" });
    h.copy.mockImplementation(async () => { h.operations.push("preserve-copy"); });
    h.remove.mockImplementation(async () => { h.operations.push("remove-source"); });
    h.move.mockImplementation(async () => { h.operations.push("move-source"); });
  });
  it("requires authentication and membership before locking or touching bytes", async () => {
    expect((await deletion(false, false)).status).toBe(401);
    h.authorize.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
    expect((await deletion()).status).toBe(403);
    expect(h.transaction).not.toHaveBeenCalled(); expect(h.copy).not.toHaveBeenCalled(); expect(h.move).not.toHaveBeenCalled();
  });
  it("refuses single deletion when assignment wins after an earlier read", async () => {
    h.race = true;
    expect((await deletion()).status).toBe(409);
    expect(h.operations).toContain("inbox-lock"); expect(h.row).not.toBeNull();
    expect(h.copy).not.toHaveBeenCalled(); expect(h.move).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
  });
  it("excludes a concurrently assigned row from bulk deletion under ordered locks", async () => {
    h.race = true;
    const result = await deletion(true);
    expect(result.status).toBe(200); expect(result.body.data.deletedCount).toBe(0);
    expect(h.operations).toContain("ordered-lock"); expect(h.row).not.toBeNull();
    expect(h.copy).not.toHaveBeenCalled(); expect(h.move).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
  });
  it.each([false, true])("preserves bytes while locked, commits row deletion, then removes the original (bulk=%s)", async (bulk) => {
    const result = await deletion(bulk);
    expect(result.status).toBe(200); expect(h.row).toBeNull();
    expect(h.operations.indexOf("inbox-lock")).toBeLessThan(h.operations.indexOf("preserve-copy"));
    expect(h.operations.indexOf("preserve-copy")).toBeLessThan(h.operations.indexOf("delete-row"));
    expect(h.operations.indexOf("commit")).toBeLessThan(h.operations.indexOf("remove-source"));
    expect(h.copy).toHaveBeenCalledTimes(1); expect(h.move).not.toHaveBeenCalled();
    expect(h.selectionSql.some(sql => sql.includes('"lab_organization_id"'))).toBe(true);
  });
  it("keeps the original if row deletion rolls back", async () => {
    h.failDelete = true;
    expect((await deletion()).status).toBe(500); expect(h.row).not.toBeNull();
    expect(h.copy).toHaveBeenCalledTimes(1); expect(h.remove).not.toHaveBeenCalled(); expect(h.move).not.toHaveBeenCalled();
  });
  it("does not roll back a successful deletion if recoverable disk cleanup fails", async () => {
    h.remove.mockRejectedValueOnce(new Error("Synthetic cleanup failure"));
    expect((await deletion()).status).toBe(200); expect(h.row).toBeNull();
    expect(h.copy).toHaveBeenCalledTimes(1); expect(h.operations).toContain("commit");
  });
  it("makes the legacy single-file assign obey the same case-then-inbox lock order", async () => {
    h.race = true;
    const result = await request(app()).post("/api/lab-inbox/doc-a/assign").set("Authorization", "Bearer fixture-user").send({ caseId: "case-new" });
    expect(result.status).toBe(409);
    expect(h.operations.indexOf("case-lock")).toBeGreaterThanOrEqual(0);
    expect(h.operations.indexOf("case-lock")).toBeLessThan(h.operations.indexOf("inbox-lock"));
    expect(h.copy).not.toHaveBeenCalled(); expect(h.move).not.toHaveBeenCalled();
  });
});
