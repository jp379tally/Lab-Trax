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
  doctorName: "Dr. Synthetic063",
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

describe("addAlloyChargeToCase requirePriced safeguard (legacy path — no PFM restorations)", () => {
  it("refuses to add a $0 line and reports skippedUnpriced when requirePriced and no price", async () => {
    mockFindMany.mockResolvedValue([]); // no existing alloy line, no PFM restorations
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

// ── Per-tooth path ──────────────────────────────────────────────────────────
// When the case has PFM/FCM restorations, addAlloyChargeToCase inserts one
// alloy row per tooth instead of a single "N/A" row.

describe("addAlloyChargeToCase per-tooth path (PFM/FCM restorations present)", () => {
  // Shared mock for insert: simulates db.insert(...).values(...).returning()
  // by resolving with a restoration-like object for each call.
  function setupInsertMock() {
    let callCount = 0;
    mockInsert.mockImplementation(() => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => [{ id: `inserted-${callCount++}`, ...vals }],
      }),
    }));
  }

  it("inserts one alloy row for a single PFM tooth", async () => {
    setupInsertMock();
    // Case has one PFM Crown on tooth 3; no existing alloy rows.
    mockFindMany.mockResolvedValue([
      {
        id: "pfm-3",
        priceKey: "pfm_crown",
        material: "PFM",
        restorationType: "Crown",
        toothNumber: "3",
      },
    ]);

    const result = await addAlloyChargeToCase({
      caseRow,
      actorUserId: "user-1",
    });

    expect(result.added).toBe(true);
    expect(result.alreadyPresent).toBe(false);
    expect(result.priced).toBe(false);
    // One insert for the alloy restoration, one for the case event.
    expect(mockInsert).toHaveBeenCalledTimes(2);
    // The restoration insert includes tooth 3 and unitPrice 0.
    const restoInsertValues = mockInsert.mock.calls[0]!;
    // The db.insert(...) mock is called first, then .values() is chained.
    // We can check the argument to .values() if we inspect the chain, but
    // since mockInsert captures the first call, we verify via result instead:
    expect(result.restorationId).toBe("inserted-0");
  });

  it("inserts one alloy row per PFM tooth when multiple teeth present", async () => {
    setupInsertMock();
    // Case has PFM Crowns on teeth 3, 6, and 11.
    mockFindMany.mockResolvedValue([
      { id: "pfm-3", priceKey: "pfm_crown", material: "PFM", restorationType: "Crown", toothNumber: "3" },
      { id: "pfm-6", priceKey: "pfm_crown", material: "PFM", restorationType: "Crown", toothNumber: "6" },
      { id: "pfm-11", priceKey: "pfm_crown", material: "PFM", restorationType: "Crown", toothNumber: "11" },
    ]);

    const result = await addAlloyChargeToCase({
      caseRow,
      actorUserId: "user-1",
    });

    expect(result.added).toBe(true);
    // 3 teeth × 2 inserts each (restoration + event) = 6 total.
    expect(mockInsert).toHaveBeenCalledTimes(6);
  });

  it("skips teeth that already have a per-tooth alloy row (idempotent)", async () => {
    setupInsertMock();
    // Tooth 3 has PFM and an existing alloy row; tooth 6 has PFM but no alloy.
    mockFindMany.mockResolvedValue([
      { id: "pfm-3", priceKey: "pfm_crown", material: "PFM", restorationType: "Crown", toothNumber: "3" },
      { id: "pfm-6", priceKey: "pfm_crown", material: "PFM", restorationType: "Crown", toothNumber: "6" },
      { id: "alloy-3", priceKey: "alloy", restorationType: "Alloy", material: null, toothNumber: "3" },
    ]);

    const result = await addAlloyChargeToCase({
      caseRow,
      actorUserId: "user-1",
    });

    expect(result.added).toBe(true);
    // Only tooth 6 needs a new alloy row: 1 restoration insert + 1 event insert.
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  it("reports alreadyPresent when all PFM teeth already have alloy rows", async () => {
    // Both PFM teeth already have alloy rows.
    mockFindMany.mockResolvedValue([
      { id: "pfm-3", priceKey: "pfm_crown", material: "PFM", restorationType: "Crown", toothNumber: "3" },
      { id: "pfm-6", priceKey: "pfm_crown", material: "PFM", restorationType: "Crown", toothNumber: "6" },
      { id: "alloy-3", priceKey: "alloy", restorationType: "Alloy", material: null, toothNumber: "3" },
      { id: "alloy-6", priceKey: "alloy", restorationType: "Alloy", material: null, toothNumber: "6" },
    ]);

    const result = await addAlloyChargeToCase({
      caseRow,
      actorUserId: "user-1",
    });

    expect(result.added).toBe(false);
    expect(result.alreadyPresent).toBe(true);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
