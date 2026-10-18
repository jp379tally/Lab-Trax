import { describe, expect, it } from "vitest";
import { agingBucket, cents, dollars, dueDateFromTerms, spreadCreditApplications, validDate } from "@/lib/accounts-payable";

describe("accounts payable money helpers", () => {
  it("parses exact integer cents without floating-point drift", async () => {
    expect(cents("12.34")).toBe(1234);
    expect(cents("-0.01")).toBe(-1);
    expect(cents("$1,234.50")).toBe(123450);
    expect(cents("1.234")).toBeNull();
    expect(cents("not money")).toBeNull();
    expect(dollars(1234)).toBe(12.34);
  });

  it("spreads vendor credit oldest-first using integer cents", async () => {
    expect(spreadCreditApplications([
      { id: "old", remainingAmount: "5.00" },
      { id: "new", remainingAmount: "10.00" },
    ], 789)).toEqual([
      { vendorCreditId: "old", amount: 5 },
      { vendorCreditId: "new", amount: 2.89 },
    ]);
  });
});

describe("accounts payable date helpers", () => {
  it("derives due dates across month and leap-year boundaries", async () => {
    expect(dueDateFromTerms("2024-02-20", 10)).toBe("2024-03-01");
    expect(dueDateFromTerms("2026-01-31", 30)).toBe("2026-03-02");
    expect(dueDateFromTerms("bad", 30)).toBeNull();
    expect(validDate("2024-02-29")).toBe(true);
    expect(validDate("2025-02-29")).toBe(false);
  });

  it("assigns due-date aging bucket boundaries", async () => {
    expect(agingBucket("2026-03-01", "2026-03-01")).toBe("current");
    expect(agingBucket("2026-02-28", "2026-03-01")).toBe("d1_30");
    expect(agingBucket("2026-01-30", "2026-03-01")).toBe("d1_30");
    expect(agingBucket("2026-01-29", "2026-03-01")).toBe("d31_60");
    expect(agingBucket("2025-11-30", "2026-03-01")).toBe("d90_plus");
  });
});