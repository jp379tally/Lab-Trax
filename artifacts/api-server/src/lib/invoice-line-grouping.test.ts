import { describe, it, expect } from "vitest";
import {
  parseToothInt,
  buildBasicDescription,
  buildGroupedSyncItems,
  parseConnectors,
  findConnectedComponents,
  buildBridgeAwareLineItems,
} from "./invoice-line-grouping";

type Restoration = {
  id: string;
  toothNumber: string;
  restorationType: string;
  material: string | null;
  quantity: number;
  unitPrice: string;
};

const r = (over: Partial<Restoration> & { id: string }): Restoration => ({
  toothNumber: "",
  restorationType: "Crown",
  material: null,
  quantity: 1,
  unitPrice: "0.00",
  ...over,
});

describe("parseToothInt", () => {
  it("accepts valid tooth numbers 1-32", () => {
    expect(parseToothInt("1")).toBe(1);
    expect(parseToothInt("32")).toBe(32);
    expect(parseToothInt("8")).toBe(8);
  });
  it("rejects out-of-range and non-numeric values", () => {
    expect(parseToothInt("0")).toBeNull();
    expect(parseToothInt("33")).toBeNull();
    expect(parseToothInt("")).toBeNull();
    expect(parseToothInt("abc")).toBeNull();
  });
});

describe("buildBasicDescription", () => {
  it("renders alloy without a tooth", () => {
    expect(
      buildBasicDescription(
        { restorationType: "Alloy", toothNumber: "", material: null },
        false,
      ),
    ).toBe("Alloy");
    expect(
      buildBasicDescription(
        { restorationType: "Alloy", toothNumber: "", material: null },
        true,
      ),
    ).toBe("Alloy (no-charge remake)");
  });
  it("includes material + tooth for standard restorations", () => {
    expect(
      buildBasicDescription(
        { restorationType: "Crown", toothNumber: "8", material: "Zirconia" },
        false,
      ),
    ).toBe("Zirconia Crown - Tooth 8");
  });
  it("omits material when absent", () => {
    expect(
      buildBasicDescription(
        { restorationType: "Crown", toothNumber: "8", material: null },
        false,
      ),
    ).toBe("Crown - Tooth 8");
  });
});

describe("buildGroupedSyncItems", () => {
  it("keeps a single restoration as its own line", () => {
    const items = buildGroupedSyncItems(
      [r({ id: "a", toothNumber: "8", material: "Zirconia", unitPrice: "100.00" })],
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      caseRestorationId: "a",
      toothNumber: 8,
      toothLabel: null,
      description: "Zirconia Crown - Tooth 8",
      quantity: 1,
      unitPrice: "100.00",
      lineTotal: "100.00",
    });
  });

  it("collapses same-material/same-type restorations into one line with a tooth label", () => {
    const items = buildGroupedSyncItems(
      [
        r({ id: "a", toothNumber: "3", material: "PFM", unitPrice: "120.00" }),
        r({ id: "b", toothNumber: "5", material: "PFM", unitPrice: "120.00" }),
        r({ id: "c", toothNumber: "4", material: "PFM", unitPrice: "120.00" }),
      ],
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      toothLabel: "3, 4, 5",
      description: "PFM Crown",
      quantity: 3,
      unitPrice: "120.00",
      lineTotal: "360.00",
    });
  });

  it("zeroes out a no-charge remake", () => {
    const items = buildGroupedSyncItems(
      [r({ id: "a", toothNumber: "8", material: "Zirconia", unitPrice: "100.00" })],
      true,
    );
    expect(items[0]).toMatchObject({ unitPrice: "0.00", lineTotal: "0.00" });
  });
});

describe("parseConnectors", () => {
  it("normalises pairs to lo-hi keys", () => {
    const set = parseConnectors("14-13, 14-15");
    expect(set.has("13-14")).toBe(true);
    expect(set.has("14-15")).toBe(true);
  });
  it("returns empty set for null/blank", () => {
    expect(parseConnectors(null).size).toBe(0);
    expect(parseConnectors("").size).toBe(0);
  });
});

describe("findConnectedComponents", () => {
  it("groups connected teeth into one component", () => {
    const comps = findConnectedComponents(
      [13, 14, 15, 20],
      parseConnectors("13-14,14-15"),
    );
    const sorted = comps.map((c) => c.join(",")).sort();
    expect(sorted).toContain("13,14,15");
    expect(sorted).toContain("20");
  });
});

describe("buildBridgeAwareLineItems", () => {
  it("falls back to material grouping when there are no connectors", () => {
    const items = buildBridgeAwareLineItems(
      [
        r({ id: "a", toothNumber: "3", material: "PFM", unitPrice: "100.00" }),
        r({ id: "b", toothNumber: "4", material: "PFM", unitPrice: "100.00" }),
      ],
      null,
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: "PFM Crown", quantity: 2 });
  });

  it("collapses a pontic-containing connected span into a single bridge line", () => {
    const items = buildBridgeAwareLineItems(
      [
        r({ id: "a", toothNumber: "13", restorationType: "Crown", material: "Zirconia", unitPrice: "200.00" }),
        r({ id: "b", toothNumber: "14", restorationType: "Pontic", material: "Zirconia", unitPrice: "200.00" }),
        r({ id: "c", toothNumber: "15", restorationType: "Crown", material: "Zirconia", unitPrice: "200.00" }),
      ],
      "13-14,14-15",
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("#13-15 Zirconia Bridge – 3 units");
    expect(items[0].quantity).toBe(3);
    expect(items[0].lineTotal).toBe("600.00");
    expect(items[0].caseRestorationId).toBe("a");
  });

  it("does not collapse a connected span without a pontic", () => {
    const items = buildBridgeAwareLineItems(
      [
        r({ id: "a", toothNumber: "13", restorationType: "Crown", material: "Zirconia", unitPrice: "200.00" }),
        r({ id: "b", toothNumber: "14", restorationType: "Crown", material: "Zirconia", unitPrice: "200.00" }),
      ],
      "13-14",
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("Zirconia Crown");
    expect(items[0].quantity).toBe(2);
  });
});
