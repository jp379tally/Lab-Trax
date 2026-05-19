import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildLineItemDescription } from "./pricing.js";
import { DEFAULT_TIER_ITEMS } from "./material-mapping.js";

// ---------------------------------------------------------------------------
// Mock the @workspace/db module so resolveItemLabel can be tested without a
// live database.  We intercept `db.query.labItemLabels.findFirst` and let each
// test control what the "database" returns.
//
// mockFindFirst must be declared via vi.hoisted() so it is available at the
// point vi.mock() factory executes (vi.mock calls are hoisted to the top of
// the compiled file, before any const/let declarations).
// ---------------------------------------------------------------------------

const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      ...((actual as any).db ?? {}),
      query: {
        labItemLabels: { findFirst: mockFindFirst },
      },
    },
  };
});

// Import AFTER mocking so the module picks up the mock
const { resolveItemLabel } = await import("./pricing.js");

// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFindFirst.mockReset();
});

// ============================================================
// buildLineItemDescription — pure formatter, no DB involved
// ============================================================

describe("buildLineItemDescription", () => {
  it("formats a numeric tooth number with a hash prefix", () => {
    expect(buildLineItemDescription("30", "Zirconia Crown")).toBe(
      "#30 Zirconia Crown",
    );
    expect(buildLineItemDescription("1", "E.max Crown")).toBe("#1 E.max Crown");
    expect(buildLineItemDescription("14", "PFM Crown")).toBe("#14 PFM Crown");
  });

  it("treats non-numeric tooth tokens as arch-level (no hash prefix)", () => {
    expect(buildLineItemDescription("Upper", "Denture")).toBe("Upper Denture");
    expect(buildLineItemDescription("Lower", "Partial")).toBe("Lower Partial");
    expect(buildLineItemDescription("Full Arch", "Night Guard - Hard")).toBe(
      "Full Arch Night Guard - Hard",
    );
    expect(buildLineItemDescription("Maxillary", "Retainer - Hawley")).toBe(
      "Maxillary Retainer - Hawley",
    );
  });

  it("returns just the label when tooth/arch is empty or null", () => {
    expect(buildLineItemDescription("", "Implant")).toBe("Implant");
    expect(buildLineItemDescription(null, "Snore Guard")).toBe("Snore Guard");
    expect(buildLineItemDescription(undefined, "Sports Guard")).toBe(
      "Sports Guard",
    );
  });

  it("trims whitespace from the tooth token before evaluating", () => {
    expect(buildLineItemDescription("  30  ", "Zirconia Crown")).toBe(
      "#30 Zirconia Crown",
    );
    expect(buildLineItemDescription("  Upper  ", "Denture")).toBe(
      "Upper Denture",
    );
    // Whitespace-only → treated as empty → just the label
    expect(buildLineItemDescription("   ", "Implant")).toBe("Implant");
  });
});

// ============================================================
// resolveItemLabel — mocked DB, tests configured vs. fallback
// ============================================================

describe("resolveItemLabel — configured row takes priority over static default", () => {
  it("returns the admin-configured label when a DB row exists", async () => {
    mockFindFirst.mockResolvedValueOnce({
      label: "Zirconia (Full-Contour)",
      priceKey: "zirconia_crown",
      labOrganizationId: "lab-1",
    });

    const result = await resolveItemLabel("lab-1", "zirconia_crown");

    expect(result).toBe("Zirconia (Full-Contour)");
    expect(mockFindFirst).toHaveBeenCalledOnce();
  });

  it("falls back to the static default label when no DB row exists", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await resolveItemLabel("lab-1", "zirconia_crown");

    expect(result).toBe("Zirconia Crown"); // static DEFAULT_TIER_ITEMS label
    expect(mockFindFirst).toHaveBeenCalledOnce();
  });

  it("falls back to the static default label when the DB row has an empty label", async () => {
    mockFindFirst.mockResolvedValueOnce({
      label: "",
      priceKey: "emax_crown",
      labOrganizationId: "lab-1",
    });

    const result = await resolveItemLabel("lab-1", "emax_crown");

    expect(result).toBe("E.max Crown"); // static fallback
  });

  it("generates a title-cased fallback for keys not in DEFAULT_TIER_ITEMS", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await resolveItemLabel("lab-1", "custom_appliance");

    expect(result).toBe("Custom Appliance");
  });

  it("different labs can have different labels for the same price key", async () => {
    mockFindFirst
      .mockResolvedValueOnce({ label: "Zirconia (Full-Contour)", labOrganizationId: "lab-A", priceKey: "zirconia_crown" })
      .mockResolvedValueOnce({ label: "Multilayer Zirconia", labOrganizationId: "lab-B", priceKey: "zirconia_crown" });

    const labelA = await resolveItemLabel("lab-A", "zirconia_crown");
    const labelB = await resolveItemLabel("lab-B", "zirconia_crown");

    expect(labelA).toBe("Zirconia (Full-Contour)");
    expect(labelB).toBe("Multilayer Zirconia");
  });

  it("resolves all standard keys to non-empty static defaults when no DB rows exist", async () => {
    for (const item of DEFAULT_TIER_ITEMS) {
      mockFindFirst.mockResolvedValueOnce(null);
      const result = await resolveItemLabel("lab-1", item.key);
      expect(result).toBeTruthy();
      expect(typeof result).toBe("string");
    }
  });
});

// ============================================================
// Static default catalogue coverage
// ============================================================

describe("static default label fallback catalogue", () => {
  it("DEFAULT_TIER_ITEMS contains a non-empty label for every known price key", () => {
    for (const item of DEFAULT_TIER_ITEMS) {
      expect(item.label).toBeTruthy();
      expect(typeof item.label).toBe("string");
    }
  });

  it("every DEFAULT_TIER_ITEMS key is distinct (no duplicate price keys)", () => {
    const keys = DEFAULT_TIER_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("spot-checks representative static defaults", () => {
    const find = (key: string) =>
      DEFAULT_TIER_ITEMS.find((i) => i.key === key)?.label;

    expect(find("zirconia_crown")).toBe("Zirconia Crown");
    expect(find("emax_crown")).toBe("E.max Crown");
    expect(find("pfm_crown")).toBe("PFM Crown");
    expect(find("denture")).toBe("Denture");
    expect(find("partial")).toBe("Partial");
    expect(find("implant")).toBe("Implant");
    expect(find("night_guard_hard")).toBe("Night Guard - Hard");
    expect(find("night_guard_soft")).toBe("Night Guard - Soft");
    expect(find("night_guard_hard_soft")).toBe("Night Guard - Hard/Soft");
    expect(find("retainer_hawley")).toBe("Retainer - Hawley");
    expect(find("retainer_hard")).toBe("Retainer - Hard");
    expect(find("retainer_lingual")).toBe("Retainer - Lingual");
    expect(find("snore_guard")).toBe("Snore Guard");
    expect(find("sports_guard")).toBe("Sports Guard");
  });
});

// ============================================================
// Combined formatter + configured label (end-to-end description)
// ============================================================

describe("end-to-end description with configured label", () => {
  it("produces the correct description for a numeric tooth with a custom label", async () => {
    mockFindFirst.mockResolvedValueOnce({
      label: "Zirconia (Full-Contour)",
      labOrganizationId: "lab-1",
      priceKey: "zirconia_crown",
    });

    const label = await resolveItemLabel("lab-1", "zirconia_crown");
    expect(buildLineItemDescription("30", label)).toBe(
      "#30 Zirconia (Full-Contour)",
    );
  });

  it("produces the correct description for an arch token with a custom label", async () => {
    mockFindFirst.mockResolvedValueOnce({
      label: "Complete Denture",
      labOrganizationId: "lab-1",
      priceKey: "denture",
    });

    const label = await resolveItemLabel("lab-1", "denture");
    expect(buildLineItemDescription("Upper", label)).toBe(
      "Upper Complete Denture",
    );
  });

  it("produces the correct description with no tooth when label is custom", async () => {
    mockFindFirst.mockResolvedValueOnce({
      label: "Precision Implant",
      labOrganizationId: "lab-1",
      priceKey: "implant",
    });

    const label = await resolveItemLabel("lab-1", "implant");
    expect(buildLineItemDescription(null, label)).toBe("Precision Implant");
  });
});
