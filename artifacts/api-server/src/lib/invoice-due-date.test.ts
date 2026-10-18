/**
 * Unit tests for invoiceDueDate — covers the configurable dayOfMonth parameter
 * added alongside the invoiceDueDayOfMonth org column.
 */
import { describe, expect, it } from "vitest";
import { invoiceDueDate } from "./invoice-due-date.js";

describe("invoiceDueDate", () => {
  it("defaults to day 10 when dayOfMonth is not provided", () => {
    const issued = new Date("2025-01-15T12:00:00Z");
    const due = invoiceDueDate(issued);
    expect(due.toISOString()).toBe("2025-02-10T00:00:00.000Z");
  });

  it("defaults to day 10 when dayOfMonth is null", () => {
    const issued = new Date("2025-03-05T00:00:00Z");
    const due = invoiceDueDate(issued, null);
    expect(due.toISOString()).toBe("2025-04-10T00:00:00.000Z");
  });

  it("uses a custom dayOfMonth when provided", () => {
    const issued = new Date("2025-06-20T08:00:00Z");
    const due = invoiceDueDate(issued, 15);
    expect(due.toISOString()).toBe("2025-07-15T00:00:00.000Z");
  });

  it("uses day 1 when dayOfMonth is 1", () => {
    const issued = new Date("2025-09-01T00:00:00Z");
    const due = invoiceDueDate(issued, 1);
    expect(due.toISOString()).toBe("2025-10-01T00:00:00.000Z");
  });

  it("uses day 28 when dayOfMonth is 28", () => {
    const issued = new Date("2025-11-01T00:00:00Z");
    const due = invoiceDueDate(issued, 28);
    expect(due.toISOString()).toBe("2025-12-28T00:00:00.000Z");
  });

  it("clamps dayOfMonth below 1 to 1", () => {
    const issued = new Date("2025-02-01T00:00:00Z");
    const due = invoiceDueDate(issued, 0);
    expect(due.toISOString()).toBe("2025-03-01T00:00:00.000Z");
  });

  it("clamps dayOfMonth above 28 to 28", () => {
    const issued = new Date("2025-02-01T00:00:00Z");
    const due = invoiceDueDate(issued, 31);
    expect(due.toISOString()).toBe("2025-03-28T00:00:00.000Z");
  });

  it("wraps to next year when issued in December", () => {
    const issued = new Date("2025-12-20T00:00:00Z");
    const due = invoiceDueDate(issued, 10);
    expect(due.toISOString()).toBe("2026-01-10T00:00:00.000Z");
  });

  it("wraps to next year with custom day when issued in December", () => {
    const issued = new Date("2024-12-31T23:59:59Z");
    const due = invoiceDueDate(issued, 20);
    expect(due.toISOString()).toBe("2025-01-20T00:00:00.000Z");
  });

  it("is UTC-based — issued on last-day-of-month still uses that month", () => {
    const issued = new Date("2025-01-31T23:59:59Z");
    const due = invoiceDueDate(issued, 5);
    expect(due.toISOString()).toBe("2025-02-05T00:00:00.000Z");
  });
});
