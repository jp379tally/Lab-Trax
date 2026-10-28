import { describe, expect, it } from "vitest";
import {
  formatInvoiceDate,
  hasInvoiceDateRepairChanges,
  invoiceDateInputHasChanged,
  isLikelyLegacyShiftedInvoiceDate,
  invoiceDateInputToTimestamp,
  invoiceTimestampToDateInput,
} from "../invoice-date";
import { computeInvoiceDateRange } from "../invoice-date-filter";

describe("invoice date-only conversion", () => {
  it("reads canonical timestamps by UTC calendar date", () => {
    expect(invoiceTimestampToDateInput("2026-01-15T00:00:00.000Z")).toBe("2026-01-15");
    expect(formatInvoiceDate("2026-01-15T00:00:00.000Z")).toBe("01/15/2026");
    expect(formatInvoiceDate("2026-01-15T12:00:00.000Z")).toBe("01/15/2026");
  });

  it("serializes date input as canonical UTC midnight", () => {
    expect(invoiceDateInputToTimestamp("2026-01-15")).toBe("2026-01-15T00:00:00.000Z");
  });

  it("does not treat the same displayed calendar date as an issue-date edit", () => {
    expect(invoiceDateInputHasChanged("2026-01-15", "2026-01-15T05:30:00.000Z")).toBe(false);
    expect(invoiceDateInputHasChanged("2026-01-16", "2026-01-15T05:30:00.000Z")).toBe(true);
    expect(invoiceDateInputHasChanged("", null)).toBe(false);
    expect(invoiceDateInputHasChanged("", "2026-01-15T05:30:00.000Z")).toBe(true);
  });

  it("remains stable through repeated save and reopen round trips", () => {
    let input = "2026-01-15";
    for (let save = 0; save < 3; save += 1) {
      const timestamp = invoiceDateInputToTimestamp(input);
      expect(timestamp).toBe("2026-01-15T00:00:00.000Z");
      input = invoiceTimestampToDateInput(timestamp);
      expect(input).toBe("2026-01-15");
    }
  });

  it("rejects malformed and impossible calendar dates", () => {
    expect(invoiceDateInputToTimestamp("2026-02-30")).toBeNull();
    expect(invoiceDateInputToTimestamp("01/15/2026")).toBeNull();
    expect(invoiceTimestampToDateInput("not-a-date")).toBe("");
  });
});

describe("desktop invoice list date boundaries", () => {
  it("keeps the local Today/Yesterday labels but queries whole UTC days at month boundaries", () => {
    const now = new Date(2026, 2, 1, 0, 30);
    expect(computeInvoiceDateRange("today", "", "", now)).toEqual({
      startDate: new Date("2026-03-01T00:00:00.000Z"),
      endDate: new Date("2026-03-02T00:00:00.000Z"),
    });
    expect(computeInvoiceDateRange("yesterday", "", "", now)).toEqual({
      startDate: new Date("2026-02-28T00:00:00.000Z"),
      endDate: new Date("2026-03-01T00:00:00.000Z"),
    });
  });

  it("treats a same-day custom range as the full UTC issue day", () => {
    expect(computeInvoiceDateRange("custom", "2026-12-31", "2026-12-31")).toEqual({
      startDate: new Date("2026-12-31T00:00:00.000Z"),
      endDate: new Date("2027-01-01T00:00:00.000Z"),
    });
  });
});

describe("hasInvoiceDateRepairChanges", () => {
  it("allows same-calendar-day canonicalization of a legacy timestamp", () => {
    expect(
      hasInvoiceDateRepairChanges({
        issuedAt: "2026-01-15T05:00:00.000Z",
        dueAt: "2026-02-15T00:00:00.000Z",
        createdAt: "2026-09-10T12:00:00.000Z",
        repairedIssuedAt: "2026-01-15",
        repairedDueAt: "2026-02-15",
      }),
    ).toBe(true);
  });
});

describe("isLikelyLegacyShiftedInvoiceDate", () => {
  it("flags only non-midnight timestamps created before the date-only fix", () => {
    expect(
      isLikelyLegacyShiftedInvoiceDate(
        "2026-01-15T05:00:00.000Z",
        "2026-09-10T12:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      isLikelyLegacyShiftedInvoiceDate(
        "2026-01-15T00:00:00.000Z",
        "2026-09-10T12:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      isLikelyLegacyShiftedInvoiceDate(
        "2026-09-11T15:00:00.000Z",
        "2026-09-11T15:00:00.000Z",
      ),
    ).toBe(false);
    expect(isLikelyLegacyShiftedInvoiceDate(null, null)).toBe(false);
  });
});