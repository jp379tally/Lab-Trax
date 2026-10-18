import { describe, it, expect } from "vitest";
import {
  parseToothInt,
  buildBasicDescription,
  buildGroupedSyncItems,
  parseConnectors,
  findConnectedComponents,
  buildBridgeAwareLineItems,
} from "./invoice-line-grouping";

it("preserves exact per-tooth quoted amounts and primary topology", () => {
  const units = [
    { id: "own-A", toothNumber: "A", restorationType: "Crown", material: "Zirconia", quantity: 1, unitPrice: "125.00" },
    { id: "own-B", toothNumber: "B", restorationType: "Pontic", material: "Zirconia", quantity: 1, unitPrice: "95.01" },
    { id: "own-C", toothNumber: "C", restorationType: "Crown", material: "Zirconia", quantity: 1, unitPrice: "140.00" },
  ];
  const items = buildBridgeAwareLineItems(units, "?A-B,?B-C", false);
  expect(items).toHaveLength(3);
  expect(items.reduce((sum, line) => sum + Number(line.lineTotal), 0)).toBe(360.01);
  expect(items.flatMap((line) => line.groupedRestorationIds)).toEqual(["own-A", "own-B", "own-C"]);
  expect(items.every((line) => line.description.includes("#A-C"))).toBe(true);
  expect(items.every((line) => Number(line.lineTotal) === line.quantity * Number(line.unitPrice))).toBe(true);
});

it("does not let appliances on a tooth scope replace connected clinical units", () => {
  const items = buildBridgeAwareLineItems([
    { id: "c2", toothNumber: "2", restorationType: "Crown", material: "Zirconia", quantity: 1, unitPrice: "120.00" },
    { id: "p3", toothNumber: "3", restorationType: "Pontic", material: "Zirconia", quantity: 1, unitPrice: "120.00" },
    { id: "c4", toothNumber: "4", restorationType: "Crown", material: "Zirconia", quantity: 1, unitPrice: "120.00" },
    { id: "model", toothNumber: "3", restorationType: "Models", material: "Stone", quantity: 1, unitPrice: "25.00" },
  ], "?2-3,?3-4", false);
  expect(items.find((item) => item.groupedRestorationIds?.includes("p3"))).toMatchObject({
    quantity: 3, lineTotal: "360.00", groupedRestorationIds: ["c2", "p3", "c4"],
  });
  expect(items.find((item) => item.caseRestorationId === "model" || item.groupedRestorationIds?.includes("model"))).toMatchObject({ lineTotal: "25.00" });
});

type Restoration = {
  id: string;
  toothNumber: string;
  restorationType: string;
  restorationSubtype?: string | null;
  arch?: "upper" | "lower" | "upper_lower" | null;
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
  it("emits one labeled quantity-1 line for a single selected arch", () => {
    const items = buildGroupedSyncItems(
      [
        r({
          id: "upper",
          toothNumber: "N/A",
          restorationType: "Full Denture",
          restorationSubtype: "removable/full-denture",
          arch: "upper",
          material: "Acrylic",
          quantity: 4,
          unitPrice: "300.00",
        }),
      ],
      false,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      caseRestorationId: "upper",
      description: "Acrylic Full Denture - Tooth N/A - Upper",
      quantity: 1,
      unitPrice: "300.00",
      lineTotal: "300.00",
      arch: "upper",
      groupedRestorationIds: ["upper"],
    });
  });

  it("keeps durable upper and lower sources as separate quantity-1 lines", () => {
    const items = buildGroupedSyncItems(
      [
        r({
          id: "upper",
          restorationType: "Night Guard",
          restorationSubtype: "ortho/night-guard",
          arch: "upper",
          material: "Hard Acrylic",
          unitPrice: "125.00",
        }),
        r({
          id: "lower",
          restorationType: "Night Guard",
          restorationSubtype: "ortho/night-guard",
          arch: "lower",
          material: "Hard Acrylic",
          unitPrice: "125.00",
        }),
      ],
      false,
    );

    expect(items).toHaveLength(2);
    expect(items.map((item) => ({
      id: item.caseRestorationId,
      description: item.description,
      quantity: item.quantity,
      total: item.lineTotal,
    }))).toEqual([
      {
        id: "upper",
        description: "Hard Acrylic Night Guard - Tooth  - Upper",
        quantity: 1,
        total: "125.00",
      },
      {
        id: "lower",
        description: "Hard Acrylic Night Guard - Tooth  - Lower",
        quantity: 1,
        total: "125.00",
      },
    ]);
  });

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
      groupedRestorationIds: ["a"],
    });
  });

  it("collapses same-material/same-type NON-PFM restorations into one line with a tooth label", () => {
    const items = buildGroupedSyncItems(
      [
        r({ id: "a", toothNumber: "3", material: "Zirconia", unitPrice: "120.00" }),
        r({ id: "b", toothNumber: "5", material: "Zirconia", unitPrice: "120.00" }),
        r({ id: "c", toothNumber: "4", material: "Zirconia", unitPrice: "120.00" }),
      ],
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      toothLabel: "3, 4, 5",
      description: "Zirconia Crown",
      quantity: 3,
      unitPrice: "120.00",
      lineTotal: "360.00",
    });
    // Grouped lines expose every collapsed restoration id (input order) so the
    // preview can map an inline price edit back to all source restorations.
    expect(items[0]!.groupedRestorationIds).toEqual(["a", "b", "c"]);
  });

  it("emits PFM restorations as per-tooth singletons (not grouped)", () => {
    const items = buildGroupedSyncItems(
      [
        r({ id: "a", toothNumber: "3", material: "PFM", unitPrice: "120.00" }),
        r({ id: "b", toothNumber: "5", material: "PFM", unitPrice: "120.00" }),
        r({ id: "c", toothNumber: "4", material: "PFM", unitPrice: "120.00" }),
      ],
      false,
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      caseRestorationId: "a",
      toothNumber: 3,
      description: "PFM Crown - Tooth 3",
      quantity: 1,
      unitPrice: "120.00",
    });
  });

  it("attaches per-tooth alloy child sub-items at $0 under PFM parents", () => {
    // One PFM restoration on tooth 3, one alloy row also on tooth 3.
    const items = buildGroupedSyncItems(
      [
        r({ id: "pfm-3", toothNumber: "3", material: "PFM", restorationType: "Crown", unitPrice: "120.00" }),
        r({ id: "alloy-3", toothNumber: "3", restorationType: "Alloy", material: null, unitPrice: "0.00" }),
      ],
      false,
    );
    // Alloy row is a sub-item of the PFM parent, not a top-level line.
    expect(items).toHaveLength(1);
    const pfmItem = items[0]!;
    expect(pfmItem.caseRestorationId).toBe("pfm-3");
    expect(pfmItem.childItems).toHaveLength(1);
    const alloyChild = pfmItem.childItems![0]!;
    expect(alloyChild.description).toBe("Alloy #3");
    expect(alloyChild.unitPrice).toBe("0.00");
    expect(alloyChild.priced).toBe(false);
  });

  it("attaches per-tooth alloy to each PFM parent independently (multiple teeth)", () => {
    const items = buildGroupedSyncItems(
      [
        r({ id: "pfm-3", toothNumber: "3", material: "PFM", restorationType: "Crown", unitPrice: "120.00" }),
        r({ id: "pfm-6", toothNumber: "6", material: "PFM", restorationType: "Crown", unitPrice: "120.00" }),
        r({ id: "alloy-3", toothNumber: "3", restorationType: "Alloy", material: null, unitPrice: "0.00" }),
        r({ id: "alloy-6", toothNumber: "6", restorationType: "Alloy", material: null, unitPrice: "0.00" }),
      ],
      false,
    );
    expect(items).toHaveLength(2);
    const tooth3 = items.find((i) => i.caseRestorationId === "pfm-3")!;
    const tooth6 = items.find((i) => i.caseRestorationId === "pfm-6")!;
    expect(tooth3.childItems?.[0]?.description).toBe("Alloy #3");
    expect(tooth6.childItems?.[0]?.description).toBe("Alloy #6");
    // Both children are at $0 and unpriced.
    expect(tooth3.childItems?.[0]?.priced).toBe(false);
    expect(tooth6.childItems?.[0]?.priced).toBe(false);
  });

  it("renders a legacy N/A alloy row as a top-level line (backward compat)", () => {
    const items = buildGroupedSyncItems(
      [
        r({ id: "alloy-na", toothNumber: "N/A", restorationType: "Alloy", material: null, unitPrice: "45.00" }),
      ],
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      caseRestorationId: "alloy-na",
      description: "Alloy",
      unitPrice: "45.00",
    });
    expect(items[0]!.childItems).toBeUndefined();
  });

  it("treats Full Cast Metal (FCM) the same as PFM — per-tooth singleton with alloy child", () => {
    const items = buildGroupedSyncItems(
      [
        r({ id: "fcm-8", toothNumber: "8", material: "Full Cast Metal", restorationType: "Crown", unitPrice: "110.00" }),
        r({ id: "alloy-8", toothNumber: "8", restorationType: "Alloy", material: null, unitPrice: "0.00" }),
      ],
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.childItems?.[0]?.description).toBe("Alloy #8");
    expect(items[0]!.childItems?.[0]?.priced).toBe(false);
  });

  it("zeroes out a no-charge remake", () => {
    const items = buildGroupedSyncItems(
      [r({ id: "a", toothNumber: "8", material: "Zirconia", unitPrice: "100.00" })],
      true,
    );
    expect(items[0]).toMatchObject({ unitPrice: "0.00", lineTotal: "0.00" });
  });

  it("keeps each flipper tooth as its own invoice line (never collapses by material)", () => {
    // Two flippers of the same material are separate physical appliances —
    // one for tooth 3 (upper arch) and one for tooth 29 (lower arch).
    // The restorationSubtype "Removable/flippers" must prevent grouping.
    const items = buildGroupedSyncItems(
      [
        r({
          id: "a",
          toothNumber: "3",
          restorationType: "Removable",
          restorationSubtype: "Removable/flippers",
          material: "Flexible",
          unitPrice: "85.00",
        }),
        r({
          id: "b",
          toothNumber: "29",
          restorationType: "Removable",
          restorationSubtype: "Removable/flippers",
          material: "Flexible",
          unitPrice: "85.00",
        }),
      ],
      false,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      caseRestorationId: "a",
      toothNumber: 3,
      quantity: 1,
      unitPrice: "85.00",
      lineTotal: "85.00",
    });
    expect(items[1]).toMatchObject({
      caseRestorationId: "b",
      toothNumber: 29,
      quantity: 1,
      unitPrice: "85.00",
      lineTotal: "85.00",
    });
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
  it("prices the exact #2–4 bridge from all three source quotes, without copying rates or identities", () => {
    const units = [
      r({ id: "c2", toothNumber: "2", material: "Zirconia", unitPrice: "125.00" }),
      r({ id: "p3", toothNumber: "3", restorationType: "Pontic", material: "Zirconia", unitPrice: "95.00" }),
      r({ id: "c4", toothNumber: "4", material: "Zirconia", unitPrice: "140.00" }),
    ];
    const connected = buildBridgeAwareLineItems(units, "?2-3,?3-4", false);
    expect(connected).toHaveLength(3);
    expect(connected.map((line) => line.unitPrice)).toEqual(["125.00", "95.00", "140.00"]);
    expect(connected.flatMap((line) => line.groupedRestorationIds)).toEqual(["c2", "p3", "c4"]);
    expect(connected.reduce((sum, line) => sum + Number(line.lineTotal), 0)).toBe(360);
    expect(connected.every((line) => line.description.startsWith("#2-4 Zirconia Bridge;"))).toBe(true);
    const disconnected = buildBridgeAwareLineItems(units, "!2-3,!3-4", false);
    expect(disconnected.reduce((sum, line) => sum + Number(line.lineTotal), 0)).toBe(360);
    expect(disconnected.every((line) => !line.description.includes("Bridge"))).toBe(true);
  });
  it("never averages connected rates with a half-cent remainder", () => {
    const lines = buildBridgeAwareLineItems([
      r({ id: "c2", toothNumber: "2", material: "Zirconia", unitPrice: "100.00" }),
      r({ id: "c3", toothNumber: "3", material: "Zirconia", unitPrice: "100.01" }),
    ], "2-3", false);
    expect(lines.map((line) => [line.quantity, line.unitPrice, line.lineTotal]))
      .toEqual([[1, "100.00", "100.00"], [1, "100.01", "100.01"]]);
    expect(lines.flatMap((line) => line.groupedRestorationIds)).toEqual(["c2", "c3"]);
    expect(lines.every((line) => line.description.includes("Connected crowns"))).toBe(true);
  });
  it("keeps each flipper tooth as its own invoice line even with no connectors", () => {
    // Two flippers of the same material must NOT be collapsed, even in the
    // no-connector branch that normally groups same-material/same-type rows.
    const items = buildBridgeAwareLineItems(
      [
        r({
          id: "a",
          toothNumber: "3",
          restorationType: "Removable",
          restorationSubtype: "Removable/flippers",
          material: "Flexible",
          unitPrice: "85.00",
        }),
        r({
          id: "b",
          toothNumber: "29",
          restorationType: "Removable",
          restorationSubtype: "Removable/flippers",
          material: "Flexible",
          unitPrice: "85.00",
        }),
      ],
      null,
      false,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ caseRestorationId: "a", toothNumber: 3, quantity: 1 });
    expect(items[1]).toMatchObject({ caseRestorationId: "b", toothNumber: 29, quantity: 1 });
  });

  it("falls back to material grouping when there are no connectors (non-PFM)", () => {
    const items = buildBridgeAwareLineItems(
      [
        r({ id: "a", toothNumber: "3", material: "Zirconia", unitPrice: "100.00" }),
        r({ id: "b", toothNumber: "4", material: "Zirconia", unitPrice: "100.00" }),
      ],
      null,
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: "Zirconia Crown", quantity: 2 });
  });

  it("emits PFM restorations as per-tooth singletons even when connectors present", () => {
    // PFM crowns are excluded from bridge processing — they stay as singletons
    // so each can carry its Alloy child sub-item.
    const items = buildBridgeAwareLineItems(
      [
        r({ id: "a", toothNumber: "3", material: "PFM", unitPrice: "100.00" }),
        r({ id: "b", toothNumber: "4", material: "PFM", unitPrice: "100.00" }),
        r({ id: "alloy-3", toothNumber: "3", restorationType: "Alloy", material: null, unitPrice: "0.00" }),
        r({ id: "alloy-4", toothNumber: "4", restorationType: "Alloy", material: null, unitPrice: "0.00" }),
      ],
      null,
      false,
    );
    expect(items).toHaveLength(2);
    const tooth3 = items.find((i) => i.caseRestorationId === "a")!;
    expect(tooth3.childItems?.[0]?.description).toBe("Alloy #3");
    expect(tooth3.childItems?.[0]?.priced).toBe(false);
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
    expect(items[0].description).toBe("#13-15 Zirconia Bridge (2 crowns, 1 pontic) – 3 units; #13 prepared crown, #14 pontic, #15 prepared crown");
    expect(items[0].quantity).toBe(3);
    expect(items[0].lineTotal).toBe("600.00");
    expect(items[0].caseRestorationId).toBe("a");
    expect(items[0].groupedRestorationIds).toEqual(["a", "b", "c"]);
  });

  it("labels connected crown-only groups without calling them pontic bridges", () => {
    const items = buildBridgeAwareLineItems(
      [
        r({ id: "a", toothNumber: "13", restorationType: "Crown", material: "Zirconia", unitPrice: "200.00" }),
        r({ id: "b", toothNumber: "14", restorationType: "Crown", material: "Zirconia", unitPrice: "200.00" }),
      ],
      "13-14",
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("#13-14 Zirconia Connected crowns (2 crowns) – 2 units; #13 prepared crown, #14 prepared crown");
    expect(items[0].quantity).toBe(2);
  });
});
