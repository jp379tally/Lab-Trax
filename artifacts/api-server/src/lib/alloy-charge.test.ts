import { describe, it, expect, vi, beforeEach } from "vitest";

// resolveAlloyPricePreview delegates to resolveServerPriceWithSource and maps
// the result into the banner-facing { amount, priced, source } shape. Mock the
// pricing module so we can drive that result without a live database.
const { mockResolve } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
}));

vi.mock("./pricing", () => ({
  resolveServerPriceWithSource: mockResolve,
}));

// invoice-sync and @workspace/db are pulled in transitively by alloy-charge;
// stub them so importing the module doesn't require a database connection.
vi.mock("./invoice-sync", () => ({
  syncInvoiceFromRestorations: vi.fn(),
}));

const { mockFindMany, mockInsert } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: { caseRestorations: { findMany: mockFindMany } },
    insert: mockInsert,
  },
  caseEvents: {},
  caseRestorations: {},
}));

const { resolveAlloyPricePreview, addAlloyChargeToCase } = await import(
  "./alloy-charge.js"
);

const caseRow = {
  id: "case-1",
  labOrganizationId: "lab-1",
  doctorName: "Dr. Smith",
  providerOrganizationId: "prov-1",
};

beforeEach(() => {
  mockResolve.mockReset();
  mockFindMany.mockReset();
  mockInsert.mockReset();
});

describe("resolveAlloyPricePreview", () => {
  it("returns the resolved amount as priced when a tier/override price exists", async () => {
    mockResolve.mockResolvedValue({
      amount: 45,
      source: "tier",
      sourceId: "tier-1",
      sourceName: "Standard",
      key: "alloy",
    });

    const preview = await resolveAlloyPricePreview(caseRow);

    expect(preview).toEqual({ amount: 45, priced: true, source: "tier" });
  });

  it("reports priced:false with amount 0 when no alloy price is configured", async () => {
    mockResolve.mockResolvedValue(null);

    const preview = await resolveAlloyPricePreview(caseRow);

    expect(preview).toEqual({ amount: 0, priced: false, source: null });
  });

  it("treats a resolved $0 as unpriced", async () => {
    mockResolve.mockResolvedValue({
      amount: 0,
      source: "default",
      sourceId: "tier-0",
      sourceName: "Standard",
      key: "alloy",
    });

    const preview = await resolveAlloyPricePreview(caseRow);

    expect(preview.priced).toBe(false);
    expect(preview.amount).toBe(0);
  });
});

describe("addAlloyChargeToCase requirePriced safeguard", () => {
  it("refuses to add a $0 line and reports skippedUnpriced when requirePriced and no price", async () => {
    mockFindMany.mockResolvedValue([]); // no existing alloy line
    mockResolve.mockResolvedValue(null); // no configured price

    const result = await addAlloyChargeToCase({
      caseRow,
      actorUserId: "user-1",
      requirePriced: true,
    });

    expect(result).toEqual({
      added: false,
      alreadyPresent: false,
      priced: false,
      skippedUnpriced: true,
      restorationId: null,
    });
    // Critically: nothing was inserted.
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("still no-ops (alreadyPresent) when an alloy line exists, regardless of requirePriced", async () => {
    mockFindMany.mockResolvedValue([{ priceKey: "alloy" }]);

    const result = await addAlloyChargeToCase({
      caseRow,
      actorUserId: "user-1",
      requirePriced: true,
    });

    expect(result.alreadyPresent).toBe(true);
    expect(result.skippedUnpriced).toBe(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
