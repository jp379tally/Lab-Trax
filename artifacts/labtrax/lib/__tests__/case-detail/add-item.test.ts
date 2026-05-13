import { describe, it, expect } from "vitest";
import {
  formatToothDisplay,
  computeBillableCount,
  getAppliancePriceKey,
  getApplianceUnitPrice,
  buildApplianceLineItems,
  previousAddItemStep,
} from "../../case-detail/add-item";
import type { Client, PricingTier } from "../../data";

describe("formatToothDisplay", () => {
  it("groups consecutive bridge teeth into ranges", () => {
    expect(
      formatToothDisplay([8, 9, 10, 12], { 8: "bridge", 9: "bridge", 10: "bridge" }),
    ).toBe("#8-#10, #12");
  });
  it("marks missing teeth with X and otherwise with #", () => {
    expect(formatToothDisplay([8, 9], { 9: "missing" })).toBe("#8, X9");
  });
  it("returns empty string for no teeth", () => {
    expect(formatToothDisplay([], {})).toBe("");
  });
});

describe("computeBillableCount", () => {
  it("counts normals plus one for any pontic group", () => {
    expect(computeBillableCount([8, 9, 10], { 9: "bridge" })).toBe(3); // 2 normal + 1 pontic
    expect(computeBillableCount([8, 9, 10], {})).toBe(3);
    expect(computeBillableCount([8], { 8: "missing" })).toBe(0);
  });
});

describe("getAppliancePriceKey", () => {
  it.each([
    ["Night Guard", "Hard", "night_guard_hard"],
    ["Night Guard", "Soft", "night_guard_soft"],
    ["Night Guard", "Hard/Soft", "night_guard_hard_soft"],
    ["Retainer", "Hawley", "retainer_hawley"],
    ["Retainer", "Hard", "retainer_hard"],
    ["Retainer", "Lingual", "retainer_lingual"],
    ["Snore Guard", "", "snore_guard"],
    ["Sports Guard", "", "sports_guard"],
    ["Mystery", "Foo", ""],
  ])("(%s, %s) → %s", (subtype, variant, expected) => {
    expect(getAppliancePriceKey(subtype, variant)).toBe(expected);
  });
});

describe("getApplianceUnitPrice", () => {
  const tiers = [
    { id: "t1", name: "Standard", prices: { night_guard_hard: 200 } },
  ] as unknown as PricingTier[];

  it("prefers a positive client custom override", () => {
    const client = {
      tier: "Standard",
      customPricing: { night_guard_hard: 175 },
    } as unknown as Client;
    expect(
      getApplianceUnitPrice({ priceKey: "night_guard_hard", client, pricingTiers: tiers }),
    ).toBe(175);
  });
  it("falls through to tier price when override is zero or missing", () => {
    const client = {
      tier: "Standard",
      customPricing: { night_guard_hard: 0 },
    } as unknown as Client;
    expect(
      getApplianceUnitPrice({ priceKey: "night_guard_hard", client, pricingTiers: tiers }),
    ).toBe(200);
  });
  it("returns 0 when nothing matches", () => {
    expect(
      getApplianceUnitPrice({ priceKey: "night_guard_soft", client: undefined, pricingTiers: tiers }),
    ).toBe(0);
  });
});

describe("buildApplianceLineItems", () => {
  it("emits one line per arch when arch is Both", () => {
    const items = buildApplianceLineItems({
      subtype: "Night Guard",
      variant: "Hard",
      arch: "Both",
      unitPrice: 100,
    });
    expect(items).toHaveLength(2);
    expect(items[0].description).toContain("(Upper)");
    expect(items[1].description).toContain("(Lower)");
  });
  it("emits a single labelled line otherwise", () => {
    const items = buildApplianceLineItems({
      subtype: "Snore Guard",
      variant: "",
      arch: "Upper",
      unitPrice: 150,
    });
    expect(items).toHaveLength(1);
    expect(items[0].item).toBe("Snore Guard");
    expect(items[0].description).toBe("Snore Guard (Upper)");
    expect(items[0].amount).toBe(150);
  });
});

describe("previousAddItemStep", () => {
  it("returns to caseType from removableSubtype", () => {
    expect(
      previousAddItemStep({ current: "removableSubtype", itemCaseType: "Removable", removableSubtype: "" }),
    ).toBe("caseType");
  });
  it("toothChart back depends on case type", () => {
    expect(
      previousAddItemStep({ current: "toothChart", itemCaseType: "Removable", removableSubtype: "" }),
    ).toBe("removableSubtype");
    expect(
      previousAddItemStep({ current: "toothChart", itemCaseType: "Restorative", removableSubtype: "" }),
    ).toBe("caseType");
  });
  it("removableMaterial back depends on subtype", () => {
    expect(
      previousAddItemStep({ current: "removableMaterial", itemCaseType: "Removable", removableSubtype: "Denture" }),
    ).toBe("removableSubtype");
    expect(
      previousAddItemStep({ current: "removableMaterial", itemCaseType: "Removable", removableSubtype: "Partial" }),
    ).toBe("toothChart");
  });
  it("essex shade goes back to essex teeth", () => {
    expect(
      previousAddItemStep({ current: "applianceEssexShade", itemCaseType: "Appliance", removableSubtype: "" }),
    ).toBe("applianceEssexTeeth");
  });
});
