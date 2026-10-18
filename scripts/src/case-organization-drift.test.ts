import { describe, expect, it, vi } from "vitest";
import {
  assessCaseOrganizationConstraints,
  CASE_ORGANIZATION_CONSTRAINTS_SQL,
  CASE_ORGANIZATION_ROWS_SQL,
  inspectCaseOrganizationRows,
  type CaseOrganizationConstraint,
} from "@workspace/db/case-organization-integrity";
import { checkCaseOrganizationDrift } from "./case-organization-drift";

const intact = {
  total_cases: "4", missing_lab: "0", missing_practice: "0",
  affected_total: "0", affected_active: "0",
};
function fk(column: string): CaseOrganizationConstraint {
  return {
    name: `synthetic_${column}_fk`, columns: [column], validated: true,
    target_schema: "public", target_table: "organizations", target_columns: ["id"],
    delete_action: "r", update_action: "a", deferrable: false,
  };
}
function queryFor(rows = intact, constraints: CaseOrganizationConstraint[] = []) {
  return vi.fn(async (sql: string) => {
    if (sql === CASE_ORGANIZATION_ROWS_SQL) return { rows: [rows] };
    if (sql === CASE_ORGANIZATION_CONSTRAINTS_SQL) return { rows: constraints };
    throw new Error(`Unexpected query: ${sql}`);
  });
}

describe("case ownership drift separates rows from catalog flags", () => {
  it("reports missing FKs even when every row is intact", async () => {
    const result = await checkCaseOrganizationDrift(queryFor(), false);
    expect(result.blocking).toBe(true);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((error) => error.includes("catalog"))).toBe(true);
    expect(result.summary).toContain("0 affected");
  });

  it("allows advisory catalog drift before Publish, never row corruption", async () => {
    expect(await checkCaseOrganizationDrift(queryFor(), true)).toMatchObject({
      blocking: false, errors: [], warnings: [expect.stringContaining("missing"), expect.stringContaining("missing")],
    });
    const result = await checkCaseOrganizationDrift(queryFor({
      ...intact, missing_lab: "2", missing_practice: "2", affected_total: "3", affected_active: "2",
    }), true);
    expect(result.blocking).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("2 active, 1 deleted/historical");
    expect(result.warnings).toHaveLength(2);
  });

  it("detects deleted-only orphan rows even with validated constraints", async () => {
    const result = await checkCaseOrganizationDrift(queryFor({
      ...intact, missing_lab: "1", affected_total: "1",
    }, [fk("lab_organization_id"), fk("provider_organization_id")]), true);
    expect(result.blocking).toBe(true);
    expect(result.errors[0]).toContain("0 active, 1 deleted/historical");
    expect(result.warnings).toEqual([]);
  });

  it("accepts correct validated definitions, not just matching names", () => {
    const lab = fk("lab_organization_id");
    expect(assessCaseOrganizationConstraints([lab])[0].status).toBe("validated");
    expect(assessCaseOrganizationConstraints([{ ...lab, validated: false }])[0].status).toBe("not_validated");
    for (const change of [
      { delete_action: "c" }, { target_schema: "other" },
      { target_table: "users" }, { target_columns: ["name"] },
      { columns: ["lab_organization_id", "provider_organization_id"] },
      { update_action: "c" }, { deferrable: true },
    ]) {
      expect(assessCaseOrganizationConstraints([{ ...lab, ...change }])[0].status).toBe("wrong_definition");
    }
  });

  it("checks both data and catalog using SELECT-only probes", async () => {
    const query = queryFor(intact, [fk("lab_organization_id"), fk("provider_organization_id")]);
    expect((await checkCaseOrganizationDrift(query, false)).blocking).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    }
  });

  it("fails explicitly on malformed or unavailable data", async () => {
    await expect(inspectCaseOrganizationRows(async () => ({ rows: [] }))).rejects.toThrow();
    await expect(inspectCaseOrganizationRows(async () => ({
      rows: [{ ...intact, missing_lab: undefined }],
    }))).rejects.toThrow("Invalid case integrity count");
    await expect(checkCaseOrganizationDrift(async () => { throw new Error("unavailable"); }, true))
      .rejects.toThrow("unavailable");
  });
});
