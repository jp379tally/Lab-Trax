/**
 * Lab-catalog price-key overrides applied to pricing resolution.
 *
 * Pure tests cover `catalogPriceKeyFromMap` precedence (material override
 * beats parent subtype override beats none). DB-gated tests (skipped when
 * DATABASE_URL is absent) prove `resolveServerPriceWithSource` actually
 * prices from a catalog `priceKeyOverride` — and that with no override the
 * static `materialToPriceKey` behavior is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { catalogPriceKeyFromMap, type CatalogPriceKeyMap } from "./catalog-price-key.js";

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

describe("catalogPriceKeyFromMap", () => {
  const map: CatalogPriceKeyMap = new Map([
    ["restorative/crown_and_bridge", "partial"],
    ["restorative/crown_and_bridge/zirconia", "emax_crown"],
  ]);

  it("returns the material-level override for a 3-segment value", () => {
    expect(catalogPriceKeyFromMap(map, "restorative/crown_and_bridge/zirconia")).toBe(
      "emax_crown",
    );
  });

  it("falls back to the parent subtype override when the material has none", () => {
    expect(catalogPriceKeyFromMap(map, "restorative/crown_and_bridge/pfm")).toBe("partial");
  });

  it("returns the subtype override for a 2-segment value", () => {
    expect(catalogPriceKeyFromMap(map, "restorative/crown_and_bridge")).toBe("partial");
  });

  it("returns null for unrelated values, null input, and empty maps", () => {
    expect(catalogPriceKeyFromMap(map, "removable/dentures/acrylic")).toBeNull();
    expect(catalogPriceKeyFromMap(map, null)).toBeNull();
    expect(catalogPriceKeyFromMap(new Map(), "restorative/crown_and_bridge")).toBeNull();
  });
});

maybe("resolveServerPriceWithSource + catalog overrides (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let pricing: typeof import("./pricing.js");

  const labOrgId = rid("org");
  const userId = rid("u");
  let tierId: string;
  const catalogIds: string[] = [];
  let customSubtypeKey: string;
  let customMaterialKey: string;

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    pricing = await import("./pricing.js");
    const { db, organizations, users, pricingTiers, labCatalogEntries } = dbMod as any;

    await db.insert(users).values({
      id: userId,
      username: `catprice_${userId}`,
      email: `${userId}@test.example`,
      password: "x",
      firstName: "Cat",
      lastName: "Price",
      userType: "lab",
      role: "admin",
    });
    await db.insert(organizations).values({
      id: labOrgId,
      name: rid("Lab"),
      type: "lab",
    });
    const [tier] = await db
      .insert(pricingTiers)
      .values({
        labOrganizationId: labOrgId,
        name: "Standard",
        pricesJson: { zirconia_crown: 100, emax_crown: 250, partial: 400 },
        createdByUserId: userId,
      })
      .returning();
    tierId = tier.id;

    // Built-in material override: crown_and_bridge/zirconia → emax_crown.
    const builtinOverrideId = rid("cat");
    catalogIds.push(builtinOverrideId);
    await db.insert(labCatalogEntries).values({
      id: builtinOverrideId,
      labOrganizationId: labOrgId,
      entryType: "material",
      caseType: "restorative",
      parentKey: "crown_and_bridge",
      key: "zirconia",
      label: "Zirconia",
      isCustom: false,
      isActive: true,
      sortOrder: 0,
      priceKeyOverride: "emax_crown",
      createdByUserId: userId,
    });

    // Custom subtype with its own override, plus a custom material child
    // WITHOUT an override (must fall back to the parent's).
    const customSubtypeId = rid("cat");
    catalogIds.push(customSubtypeId);
    customSubtypeKey = `custom:${customSubtypeId}`;
    await db.insert(labCatalogEntries).values({
      id: customSubtypeId,
      labOrganizationId: labOrgId,
      entryType: "subtype",
      caseType: "restorative",
      parentKey: "",
      key: customSubtypeKey,
      label: "Hybrid Appliance",
      isCustom: true,
      isActive: true,
      sortOrder: 99,
      priceKeyOverride: "partial",
      createdByUserId: userId,
    });
    const customMaterialId = rid("cat");
    catalogIds.push(customMaterialId);
    customMaterialKey = `custom:${customMaterialId}`;
    await db.insert(labCatalogEntries).values({
      id: customMaterialId,
      labOrganizationId: labOrgId,
      entryType: "material",
      caseType: "restorative",
      parentKey: customSubtypeKey,
      key: customMaterialKey,
      label: "Hybrid Resin",
      isCustom: true,
      isActive: true,
      sortOrder: 0,
      priceKeyOverride: null,
      createdByUserId: userId,
    });
  });

  afterAll(async () => {
    const { db, organizations, users, pricingTiers, labCatalogEntries } = dbMod as any;
    const { eq, inArray } = await import("drizzle-orm");
    if (catalogIds.length > 0) {
      await db.delete(labCatalogEntries).where(inArray(labCatalogEntries.id, catalogIds));
    }
    await db.delete(pricingTiers).where(eq(pricingTiers.id, tierId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("prices from the built-in material's priceKeyOverride instead of the static key", async () => {
    const resolved = await pricing.resolveServerPriceWithSource(
      { labOrganizationId: labOrgId },
      "Zirconia",
      "Crown",
      "restorative/crown_and_bridge/zirconia",
    );
    expect(resolved?.key).toBe("emax_crown");
    expect(resolved?.amount).toBe(250);
  });

  it("keeps today's static mapping when no override exists for the subtype path", async () => {
    const resolved = await pricing.resolveServerPriceWithSource(
      { labOrganizationId: labOrgId },
      "Zirconia",
      "Crown",
      "restorative/implant/zirconia",
    );
    expect(resolved?.key).toBe("zirconia_crown");
    expect(resolved?.amount).toBe(100);
  });

  it("keeps today's static mapping when restorationSubtype is absent", async () => {
    const resolved = await pricing.resolveServerPriceWithSource(
      { labOrganizationId: labOrgId },
      "Zirconia",
      "Crown",
    );
    expect(resolved?.key).toBe("zirconia_crown");
    expect(resolved?.amount).toBe(100);
  });

  it("falls back to the parent custom subtype's override for a custom material without one", async () => {
    const resolved = await pricing.resolveServerPriceWithSource(
      { labOrganizationId: labOrgId },
      null,
      null,
      `restorative/${customSubtypeKey}/${customMaterialKey}`,
    );
    expect(resolved?.key).toBe("partial");
    expect(resolved?.amount).toBe(400);
  });
});
