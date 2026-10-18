import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { refreshCaseFinanceQueries } from "../../lib/refresh-case-finance";

const source = readFileSync(
  fileURLToPath(import.meta.resolve("../DashboardDropZone.tsx")),
  "utf8",
);
const manualSource = readFileSync(
  fileURLToPath(import.meta.resolve("../../pages/cases.tsx")), "utf8",
);

describe("desktop AI intake post-create refresh contract", () => {
  it("uses the shared helper in the iTero, ZIP, and Rx success paths", () => {
    expect(source.match(/await refreshCaseFinanceQueries\(qc\)/g)).toHaveLength(3);
    expect(source).toMatch(/POST \/api\/cases[\s\S]*?await refreshCaseFinanceQueries\(qc\)/);
    expect(manualSource).toContain("await refreshCaseFinanceQueries(qc)");
    expect(manualSource.indexOf("await refreshCaseFinanceQueries(qc)"))
      .toBeLessThan(manualSource.indexOf("setDuplicateMatches(null)", manualSource.indexOf("onSuccess: async")));
  });

  it("refreshes on new iTero cases but not on deduplicated imports", () => {
    const iteroStart = source.indexOf("if (zipSource.isItero)");
    const iteroEnd = source.indexOf("// ── Generic/Shining path", iteroStart);
    expect(iteroStart).toBeGreaterThan(-1);
    expect(iteroEnd).toBeGreaterThan(iteroStart);

    const iteroPath = source.slice(iteroStart, iteroEnd);
    const outcomeStart = iteroPath.indexOf("if (result.deduped)");
    expect(outcomeStart).toBeGreaterThan(-1);
    const beforeOutcome = iteroPath.slice(0, outcomeStart);
    const outcomes = iteroPath.slice(outcomeStart);

    // A duplicate must not trigger the post-create fan-out before the outcome
    // is known, and only the creation branch may call the shared helper.
    expect(beforeOutcome).not.toContain("refreshCaseFinanceQueries(qc)");
    expect(outcomes).toMatch(
      /if \(result\.deduped\) \{[\s\S]*?No duplicate created\.`,[\s\S]*?\}\);[\s\S]*?\} else \{\s*await refreshCaseFinanceQueries\(qc\);/,
    );
    expect(outcomes.match(/refreshCaseFinanceQueries\(qc\)/g)).toHaveLength(1);
  });

  it("covers cases, invoices, worklists, doctor finance, sales, reports, and stats", async () => {
    const client = new QueryClient();
    const keys = [
      ["cases", "paged", { organizationId: "lab-1" }],
      ["invoices", "paged", { organizationId: "lab-1" }],
      ["active-cases", "lab-1"],
      ["worklist", "lab-1"],
      ["cases", "worklist", "lab-1"],
      ["doctor-cases", "doctor-1"],
      ["doctor-invoices", "doctor-1"],
      ["invoices", "reports", "sales", "today", "lab-1"],
      ["reports", "sales", "lab-1"],
      ["stats", "summary", "lab-1"],
      ["/api/stats/revenue-series", "lab-1"],
      ["getGetStatsSummary", { organizationId: "lab-1" }],
    ];
    try {
      for (const key of keys) client.setQueryData(key, { total: "5.00" });
      client.setQueryData(["unrelated", "catalog"], {});

      await refreshCaseFinanceQueries(client);

      for (const key of keys) {
        expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
      }
      expect(client.getQueryState(["unrelated", "catalog"])?.isInvalidated).toBe(false);
    } finally {
      client.clear();
    }
  });
});