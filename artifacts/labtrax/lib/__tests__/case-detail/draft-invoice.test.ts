import { describe, it, expect } from "vitest";
import {
  buildDraftInvoice,
  findExistingInvoice,
  resolveCaseInvoice,
} from "../../case-detail/draft-invoice";
import type { Invoice, LabCase, Client, PricingTier } from "../../data";

const baseCase = {
  id: "case-1",
  caseNumber: "26-12",
  doctorName: "Dr. Smith",
  patientName: "Jane Doe",
  patientInitials: "J.D.",
  caseType: "Restorative",
  toothIndices: "#8, #9, #10",
  shade: "A2",
  material: "Zirconia",
  status: "in_design",
  isRush: false,
  notes: "",
  createdAt: new Date("2026-03-15T00:00:00Z").getTime(),
  updatedAt: 0,
  price: 0,
  dueDate: "",
  routeHistory: [],
  photos: [],
  activityLog: [],
} as unknown as LabCase;

const clients: Client[] = [];
const tiers: PricingTier[] = [];

describe("findExistingInvoice", () => {
  it("returns the directly linked invoice when caseItem.invoiceId is set", () => {
    const inv = { id: "inv-9", caseIds: [], patientName: "", clientName: "" } as unknown as Invoice;
    expect(findExistingInvoice({ ...baseCase, invoiceId: "inv-9" }, [inv])).toBe(inv);
  });
  it("falls back to caseIds inclusion", () => {
    const inv = { id: "inv-1", caseIds: ["case-1"], patientName: "", clientName: "" } as unknown as Invoice;
    expect(findExistingInvoice(baseCase, [inv])).toBe(inv);
  });
  it("matches loosely on patient + last word of doctor name", () => {
    const inv = {
      id: "inv-2",
      caseIds: [],
      patientName: "jane doe",
      clientName: "Dr. Smith",
    } as unknown as Invoice;
    expect(findExistingInvoice(baseCase, [inv])).toBe(inv);
  });
});

describe("buildDraftInvoice", () => {
  it("creates a one-line draft with computed amount and INV number", () => {
    const inv = buildDraftInvoice({ caseItem: baseCase, clients, pricingTiers: tiers });
    expect(inv.id).toBe("case-1-inv");
    expect(inv.invoiceNumber).toBe("INV-2026-2612"); // strip non-digits → "2612"
    expect(inv.lineItems).toHaveLength(1);
    expect(inv.lineItems[0].qty).toBe(3);
    expect(inv.amount).toBe(inv.lineItems[0].amount);
    expect(inv.status).toBe("open");
  });

  it("appends a $500 rush fee when isRush", () => {
    const inv = buildDraftInvoice({
      caseItem: { ...baseCase, isRush: true },
      clients,
      pricingTiers: tiers,
    });
    expect(inv.lineItems).toHaveLength(2);
    expect(inv.lineItems[1].rate).toBe(500);
    expect(inv.amount).toBe(inv.lineItems[0].amount + 500);
  });

  it("marks completed cases as paid", () => {
    const inv = buildDraftInvoice({
      caseItem: { ...baseCase, status: "complete" } as LabCase,
      clients,
      pricingTiers: tiers,
    });
    expect(inv.status).toBe("paid");
  });

  it("credits the full amount for free remakes", () => {
    const inv = buildDraftInvoice({
      caseItem: { ...baseCase, isRemake: true, price: 0 } as LabCase,
      clients,
      pricingTiers: tiers,
    });
    expect(inv.credits).toBe(inv.amount);
  });
});

describe("resolveCaseInvoice", () => {
  it("returns the existing invoice when one is found, else a draft", () => {
    const existing = {
      id: "real",
      caseIds: ["case-1"],
      patientName: "",
      clientName: "",
    } as unknown as Invoice;
    expect(resolveCaseInvoice({ caseItem: baseCase, invoices: [existing], clients, pricingTiers: tiers })).toBe(
      existing,
    );
    const draft = resolveCaseInvoice({
      caseItem: baseCase,
      invoices: [],
      clients,
      pricingTiers: tiers,
    });
    expect(draft.id).toBe("case-1-inv");
  });
});
