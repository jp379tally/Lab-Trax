import { beforeEach, describe, expect, it, vi } from "vitest";
import { CASE_ORGANIZATION_ROWS_SQL } from "@workspace/db/case-organization-integrity";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workspace/db")>(),
  pool: { query },
}));
import { runPostRestoreValidation } from "./backup";

describe("post-restore canonical case organization integrity", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql === CASE_ORGANIZATION_ROWS_SQL) {
        return { rows: [{
          total_cases: "3", missing_lab: "0", missing_practice: "0",
          affected_total: "0", affected_active: "0",
        }] };
      }
      if (sql.includes("information_schema.columns")) return { rows: [{ data_type: "date" }] };
      if (sql.includes("FROM users WHERE")) return { rows: [{ count: "1" }] };
      return { rows: [{ count: "0" }] };
    });
  });

  it("accepts intact links independently of catalog flags and counts", async () => {
    expect(await runPostRestoreValidation({
      expectedCaseCount: null, expectedInvoiceCount: null,
    })).toEqual({ valid: true, errors: [] });
    expect(query).toHaveBeenCalledWith(CASE_ORGANIZATION_ROWS_SQL);
  });

  it.each([
    { label: "lab-only", missing_lab: "1", missing_practice: "0", affected_active: "1" },
    { label: "practice-only", missing_lab: "0", missing_practice: "1", affected_active: "1" },
    { label: "deleted-only", missing_lab: "1", missing_practice: "1", affected_active: "0" },
  ])("rejects $label orphans without deleting or reassigning them", async (fixture) => {
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string) => sql === CASE_ORGANIZATION_ROWS_SQL
      ? { rows: [{ total_cases: "3", affected_total: "1", ...fixture }] }
      : original(sql));
    const result = await runPostRestoreValidation({
      expectedCaseCount: null, expectedInvoiceCount: null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`missing lab=${fixture.missing_lab}, missing practice=${fixture.missing_practice}`);
    for (const [sql] of query.mock.calls) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  });

  it("fails explicitly rather than treating a broken integrity probe as zero orphans", async () => {
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string) => {
      if (sql === CASE_ORGANIZATION_ROWS_SQL) throw new Error("synthetic unavailable relation");
      return original(sql);
    });
    expect(await runPostRestoreValidation({
      expectedCaseCount: null, expectedInvoiceCount: null,
    })).toMatchObject({
      valid: false, errors: [expect.stringContaining("synthetic unavailable relation")],
    });
  });
});
