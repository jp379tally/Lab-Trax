import { describe, it, expect } from "vitest";
import {
  findCaseInvoice,
  buildSyntheticInvoice,
  getCaseInvoice,
} from "../case-invoice";
import type { Client, Invoice, LabCase, PricingTier } from "../data";

function makeCase(overrides: Partial<LabCase> = {}): LabCase {
  return {
    id: "case-1",
    caseNumber: "C-001",
    doctorName: "Dr. Bloom",
    patientName: "Alice Smith",
    patientInitials: "A.S.",
    caseType: "Crown",
    toothIndices: "8,9",
    shade: "A2",
    material: "Zirconia",
    status: "INTAKE",
    isRush: false,
    notes: "",
    createdAt: new Date("2024-03-15T12:00:00Z").getTime(),
    updatedAt: new Date("2024-03-15T12:00:00Z").getTime(),
    price: 0,
    dueDate: "",
    routeHistory: [],
    photos: [],
    activityLog: [],
    ...overrides,
  } as LabCase;
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    invoiceNumber: "INV-2024-001",
    clientId: "client-1",
    clientName: "Dr. Bloom",
    caseIds: [],
    amount: 0,
    credits: 0,
    status: "open",
    issuedAt: 0,
    dueAt: 0,
    billTo: "Dr. Bloom",
    patientName: "Alice Smith",
    caseType: "Crown",
    teeth: "8,9",
    shade: "A2",
    caseNotes: "",
    lineItems: [],
    ...overrides,
  };
}

describe("findCaseInvoice", () => {
  it("returns the invoice referenced by caseItem.invoiceId when present", () => {
    const inv = makeInvoice({ id: "inv-explicit" });
    const c = makeCase({ invoiceId: "inv-explicit" });
    expect(findCaseInvoice(c, [inv])?.id).toBe("inv-explicit");
  });

  it("falls back to a caseIds[] match when invoiceId does not resolve", () => {
    const inv = makeInvoice({ id: "inv-by-caseids", caseIds: ["case-1"] });
    const c = makeCase({ invoiceId: "missing" });
    expect(findCaseInvoice(c, [inv])?.id).toBe("inv-by-caseids");
  });

  it("matches by patient name + doctor surname when no explicit linkage exists", () => {
    const inv = makeInvoice({
      id: "inv-by-name",
      patientName: "Alice Smith",
      clientName: "Bloom DDS",
    });
    const c = makeCase();
    expect(findCaseInvoice(c, [inv])?.id).toBe("inv-by-name");
  });

  it("does not match an invoice with the same patient but a different doctor surname", () => {
    const inv = makeInvoice({
      patientName: "Alice Smith",
      clientName: "Other Provider",
    });
    expect(findCaseInvoice(makeCase(), [inv])).toBeNull();
  });

  it("returns null when nothing in the invoice list looks related", () => {
    const inv = makeInvoice({
      patientName: "Different Patient",
      clientName: "Other Doctor",
      caseIds: ["unrelated"],
    });
    expect(findCaseInvoice(makeCase(), [inv])).toBeNull();
  });
});

describe("buildSyntheticInvoice", () => {
  const clients: Client[] = [];
  const tiers: PricingTier[] = [];

  it("uses the tooth-index count when no toothMap is present", () => {
    const inv = buildSyntheticInvoice(
      makeCase({ toothIndices: "8,9,10" }),
      clients,
      tiers
    );
    expect(inv.lineItems[0].qty).toBe(3);
  });

  it("defaults to qty 1 when there are no teeth listed at all", () => {
    const inv = buildSyntheticInvoice(
      makeCase({ toothIndices: "" }),
      clients,
      tiers
    );
    expect(inv.lineItems[0].qty).toBe(1);
  });

  it("appends a $500 rush fee when the case isRush", () => {
    const inv = buildSyntheticInvoice(
      makeCase({ isRush: true }),
      clients,
      tiers
    );
    const rush = inv.lineItems.find((li) => li.item === "Rush Fee");
    expect(rush?.amount).toBe(500);
    expect(inv.amount).toBe(inv.lineItems.reduce((s, li) => s + li.amount, 0));
  });

  it("marks a COMPLETE case's synthetic invoice as paid", () => {
    const inv = buildSyntheticInvoice(
      makeCase({ status: "COMPLETE" }),
      clients,
      tiers
    );
    expect(inv.status).toBe("paid");
  });

  it("credits a free-of-charge remake at the full invoice amount", () => {
    const inv = buildSyntheticInvoice(
      makeCase({ isRemake: true, price: 0 }),
      clients,
      tiers
    );
    expect(inv.credits).toBe(inv.amount);
  });

  it("uses a synthetic invoice number derived from the case year + number digits", () => {
    const inv = buildSyntheticInvoice(makeCase(), clients, tiers);
    expect(inv.invoiceNumber).toBe("INV-2024-001");
  });
});

describe("getCaseInvoice", () => {
  it("prefers an existing invoice over a synthetic one", () => {
    const inv = makeInvoice({ id: "real" });
    const c = makeCase({ invoiceId: "real" });
    expect(getCaseInvoice(c, [inv], [], []).id).toBe("real");
  });

  it("returns a synthetic invoice when no real invoice matches", () => {
    const c = makeCase({ patientName: "Nobody" });
    const result = getCaseInvoice(c, [], [], []);
    expect(result.id).toBe("case-1-inv");
  });
});
