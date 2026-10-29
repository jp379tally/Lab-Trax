import { describe, expect, it } from "vitest";
import {
  invoiceDateInputHasChanged,
  invoiceDateInputToTimestamp,
  invoiceTimestampToDateInput,
  isLikelyLegacyShiftedInvoiceDate,
} from "../invoice-date";

describe("invoice date input conversions", () => {
  it("displays timestamps by their UTC calendar date", () => {
    expect(invoiceTimestampToDateInput("2026-03-10T05:30:00.000Z")).toBe("2026-03-10");
    expect(invoiceTimestampToDateInput(null)).toBe("");
  });

  it("preserves unchanged dates and serializes changed dates at UTC midnight", () => {
    expect(
      invoiceDateInputHasChanged("2026-03-10", "2026-03-10T05:30:00.000Z"),
    ).toBe(false);
    expect(invoiceDateInputToTimestamp("2026-03-11")).toBe(
      "2026-03-11T00:00:00.000Z",
    );
  });

  it.each(["03/11/2026", "2026-02-29", "2026-13-01", "2026-3-01"])(
    "rejects invalid calendar date %s",
    (value) => {
      expect(invoiceDateInputToTimestamp(value)).toBeNull();
    },
  );

  it("matches the legacy shifted-date guard used by the desktop editor", () => {
    expect(
      isLikelyLegacyShiftedInvoiceDate(
        "2025-04-02T05:00:00.000Z",
        "2025-04-03T10:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      isLikelyLegacyShiftedInvoiceDate(
        "2026-10-02T05:00:00.000Z",
        "2026-10-03T10:00:00.000Z",
      ),
    ).toBe(false);
  });
});
