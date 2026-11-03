import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { lookupSupportData, resolveSupportScope } from "./support-assistant-data";
import { HttpError } from "./http";

const mocks = vi.hoisted(() => ({ select: vi.fn(), selection: vi.fn(), capability: vi.fn(), predicates: [] as any[] }));
vi.mock("./provider-selection", () => ({ requireSelectedProviderOrganization: mocks.selection }));
vi.mock("./provider-capabilities", () => ({ assertProviderOrganizationCapability: mocks.capability }));
vi.mock("@workspace/db", async () => {
  const { pgTable, text, timestamp } = await import("drizzle-orm/pg-core");
  return {
    db: { select: mocks.select },
    cases: pgTable("cases", {
      caseNumber: text("case_number"), status: text("status"), providerOrganizationId: text("provider_organization_id"),
      deletedAt: timestamp("deleted_at"), createdAt: timestamp("created_at"), dueDate: timestamp("due_date"), expectedDeliveryDate: timestamp("expected_delivery_date"),
    }),
    invoices: pgTable("invoices", {
      invoiceNumber: text("invoice_number"), status: text("status"), providerOrganizationId: text("provider_organization_id"),
      deletedAt: timestamp("deleted_at"), createdAt: timestamp("created_at"), total: text("total"), balanceDue: text("balance_due"),
    }),
  };
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.predicates.length = 0;
  mocks.selection.mockResolvedValue({ id: "practice-a" });
  mocks.capability.mockResolvedValue(undefined);
  mocks.select.mockImplementation(() => {
    const chain: any = { from: () => chain, where: (value: any) => { mocks.predicates.push(value); return chain; }, orderBy: () => chain,
      limit: vi.fn().mockResolvedValue([]) };
    return chain;
  });
});
const scope = { userId: "user-a", providerOrganizationId: "practice-a" };
describe("support data authorization and projection", () => {
  it("resolves identity through the existing provider selector", async () => {
    expect(await resolveSupportScope("user-a", "practice-a")).toEqual(scope);
    expect(mocks.selection).toHaveBeenCalledWith("user-a", "practice-a");
    expect(mocks.capability).toHaveBeenCalledWith("practice-a", "case_read");
  });
  it("queries only selected-practice nondeleted cases with no patient or note fields", async () => {
    await lookupSupportData("assigned_cases", "123", scope);
    const sql = new PgDialect().sqlToQuery(mocks.predicates[0]);
    expect(sql.sql).toContain('"cases"."provider_organization_id" =');
    expect(sql.params).toContain("practice-a"); expect(sql.params).toContain("%123%");
    expect(sql.sql).toContain('"cases"."deleted_at" is null');
    expect(Object.keys(mocks.select.mock.calls[0][0])).toEqual(["caseNumber", "status", "dueDate", "expectedDeliveryDate"]);
    expect(mocks.select.mock.results[0].value.limit).toHaveBeenCalledWith(10);
  });
  it("does not treat user search wildcards as a database wildcard", async () => {
    await lookupSupportData("assigned_cases", "%_", scope);
    const sql = new PgDialect().sqlToQuery(mocks.predicates[0]);
    expect(sql.params).toContain("%\\%\\_%");
  });
  it("excludes closed cases when portal permission is denied", async () => {
    mocks.capability.mockImplementation(async (_id: string, cap: string) => {
      if (cap === "provider_portal") throw new HttpError(403, "denied");
    });
    await lookupSupportData("assigned_cases", "", scope);
    const sql = new PgDialect().sqlToQuery(mocks.predicates[0]);
    expect(sql.sql).toContain("not in");
    expect(sql.params).toEqual(expect.arrayContaining(["complete", "delivered", "cancelled"]));
  });
  it("does not turn an entitlement infrastructure failure into data access", async () => {
    mocks.capability.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(lookupSupportData("assigned_cases", "", scope)).rejects.toThrow("database unavailable");
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("rechecks membership for every lookup and denies removed members", async () => {
    mocks.selection.mockRejectedValueOnce(new HttpError(403, "removed"));
    await expect(lookupSupportData("assigned_cases", "123", scope)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("requires billing capability before querying invoices", async () => {
    mocks.capability.mockImplementation(async (_id: string, cap: string) => { if (cap === "billing") throw new HttpError(403, "denied"); });
    await expect(lookupSupportData("assigned_invoices", "123", scope)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("scopes and minimizes invoice reads", async () => {
    const result = await lookupSupportData("assigned_invoices", "1042", scope);
    const sql = new PgDialect().sqlToQuery(mocks.predicates[0]);
    expect(sql.sql).toContain('"invoices"."provider_organization_id" =');
    expect(sql.params).toContain("practice-a");
    expect(sql.sql).toContain('"invoices"."deleted_at" is null');
    expect(Object.keys(mocks.select.mock.calls[0][0])).toEqual(["invoiceNumber", "status", "total", "balanceDue"]);
    expect(result).toMatchObject({ limitedSample: true, limit: 10 });
  });
});
