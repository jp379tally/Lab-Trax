import { describe, expect, it } from "vitest";
import { dailyBars, rankPayees, statusSegments } from "../register-analytics/registerAnalyticsModel";

describe("register analytics model", () => {
  it("ranks top 5 by combined volume and keeps component amounts", () => {
    const payees = ["a", "b", "c", "d", "e", "f"].map((p, i) => ({ payee: p, payments: "1.00", deposits: String(i), volume: String(i + 1) }));
    const r = rankPayees(payees);
    expect(r).toHaveLength(5);
    expect(r[0].payee).toBe("f");
    expect(r[0].deposits).toBe("5");
  });
  it("scales deposits and payments independently on one shared axis", () => {
    const b = dailyBars([{ date: "2026-09-01", payments: "50.00", deposits: "100.00" }, { date: "2026-09-02", payments: "0", deposits: "0" }]);
    expect(b[0].depositRatio).toBe(1);
    expect(b[0].paymentRatio).toBe(0.5);
    expect(b[1].depositRatio).toBe(0);
    expect(dailyBars([])).toEqual([]);
  });
  it("computes status counts and percentages, honest at zero", () => {
    const s = statusSegments({ postedCleared: 24, postedUncleared: 0, voided: 1, pending: 2 });
    expect(s.total).toBe(27);
    expect(s.rows[0].percent).toBe("88.9%");
    expect(s.rows[3].offset).toBeCloseTo(25 / 27);
    expect(statusSegments({ postedCleared: 0, postedUncleared: 0, voided: 0, pending: 0 }).rows[0].percent).toBe("0.0%");
  });
});
