import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  assertHistoricalInvoiceNotHeld,
  finalizedInvoiceSql,
  isHistoricalInvoiceHeld,
} from "./historical-invoice-hold";

describe("historical held invoice safeguards", () => {
  it("keeps held drafts non-collectible even if their status was changed", () => {
    const heldInvoices = [
      { status: "recovery_draft" },
      { status: "open", displayMetadataJson: { recoveryBilling: { state: "held" } } },
      { status: "paid", displayMetadataJson: { recoveryBilling: { state: "held" } } },
    ];
    for (const invoice of heldInvoices) {
      expect(isHistoricalInvoiceHeld(invoice)).toBe(true);
      expect(() => assertHistoricalInvoiceNotHeld(invoice))
        .toThrow(/remains held and cannot be edited, sent, or collected/);
    }
  });

  it("leaves released historical invoices and ordinary invoices on normal billing paths", () => {
    const released = {
      status: "open",
      displayMetadataJson: { recoveryBilling: { state: "released" } },
    };
    expect(isHistoricalInvoiceHeld(released)).toBe(false);
    expect(() => assertHistoricalInvoiceNotHeld(released)).not.toThrow();
    expect(() => assertHistoricalInvoiceNotHeld({ status: "open" })).not.toThrow();
  });

  it("excludes only the held recovery status and held metadata from financial queries", () => {
    const query = new PgDialect().sqlToQuery(finalizedInvoiceSql());
    expect(query.sql).toContain("status");
    expect(query.sql).toContain("'recoveryBilling'->>'state'");
    expect(query.sql).toContain("'held'");
    expect(query.params).toEqual(["recovery_draft"]);
  });
});
