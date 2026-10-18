import { describe, expect, it } from "vitest";
import {
  statementIsOverdue,
  summarizePracticeAccounts,
} from "./statements";

const practice = {
  id: "practice-1",
  name: "Dental One",
  displayName: null,
  billingEmail: "billing@example.com",
  phone: null,
};

function invoice(id: string, balanceDue: number) {
  return {
    id,
    providerOrganizationId: practice.id,
    status: "open",
    balanceDue,
    deletedAt: null,
  };
}

function statement(
  id: string,
  invoiceIdsJson: string[],
  createdAt: string,
  periodEnd = "2026-01-31T23:59:59.999Z",
) {
  return {
    id,
    providerOrganizationId: practice.id,
    periodStart: new Date("2026-01-01T00:00:00.000Z"),
    periodEnd: new Date(periodEnd),
    invoiceIdsJson,
    createdAt: new Date(createdAt),
  };
}

describe("statement account summaries", () => {
  it("uses live remaining balances and prevents statement/current-invoice double counting", () => {
    const [row] = summarizePracticeAccounts({
      invoices: [invoice("covered", 40), invoice("current", 25)],
      statements: [
        statement("new", ["covered"], "2026-02-05T00:00:00.000Z"),
        statement("old-repeat", ["covered"], "2026-02-01T00:00:00.000Z"),
      ],
      practices: [practice],
      asOf: new Date("2026-02-12T00:00:00.000Z"),
    });
    expect(row.billingEmail).toBe("billing@example.com");
    expect(row.openInvoiceCount).toBe(1);
    expect(row.openInvoiceTotal).toBe(25);
    expect(row.unpaidStatements.map((s) => [s.id, s.remainingBalance])).toEqual([
      ["new", 40],
    ]);
    expect(row.totalOpenBalance).toBe(65);
    expect(row.overdueBalance).toBe(40);
  });

  it("keeps multiple distinct unpaid statements newest first and trims blank email", () => {
    const [row] = summarizePracticeAccounts({
      invoices: [invoice("jan", 30), invoice("dec", 20)],
      statements: [
        statement("dec", ["dec"], "2026-01-03T00:00:00.000Z", "2025-12-31T23:59:59.999Z"),
        statement("jan", ["jan"], "2026-02-03T00:00:00.000Z"),
      ],
      practices: [{ ...practice, billingEmail: "  " }],
      asOf: new Date("2026-02-10T12:00:00.000Z"),
    });
    expect(row.billingEmail).toBeNull();
    expect(row.unpaidStatements.map((s) => s.id)).toEqual(["jan", "dec"]);
    expect(row.totalOpenBalance).toBe(50);
    expect(row.overdueBalance).toBe(20);
  });

  it("becomes overdue only after the full 10th day of the following month", () => {
    const periodEnd = new Date("2026-02-01T00:00:00.000Z");
    expect(statementIsOverdue(periodEnd, new Date("2026-02-09T23:59:59.999Z"))).toBe(false);
    expect(statementIsOverdue(periodEnd, new Date("2026-02-10T23:59:59.999Z"))).toBe(false);
    expect(statementIsOverdue(periodEnd, new Date("2026-02-11T00:00:00.000Z"))).toBe(true);
  });
});