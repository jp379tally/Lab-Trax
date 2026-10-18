import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, catalogColumns } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  catalogColumns: {
    labOrganizationId: "labOrganizationId",
    entryType: "entryType",
    caseType: "caseType",
    parentKey: "parentKey",
    key: "key",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

vi.mock("@workspace/db", () => ({
  db: { query: { labCatalogEntries: { findFirst } } },
  labCatalogEntries: catalogColumns,
}));

import { resolveRestorationPriceKey } from "./restoration-pricing.js";

describe("resolveRestorationPriceKey", () => {
  beforeEach(() => {
    findFirst.mockReset();
    findFirst.mockResolvedValue(undefined);
  });

  it("uses the taxonomy default for a structured material leaf", async () => {
    await expect(
      resolveRestorationPriceKey({
        labOrganizationId: "lab-1",
        restorationType: "unrecognized freeform type",
        material: "unrecognized freeform material",
        restorationSubtype: "restorative/crown_and_bridge/zirconia",
      }),
    ).resolves.toBe("zirconia_crown");

    expect(findFirst).toHaveBeenCalled();
  });

  it("lets a lab material override beat the taxonomy default", async () => {
    findFirst.mockResolvedValue({
      priceKeyOverride: "lab_specific_zirconia",
    });

    await expect(
      resolveRestorationPriceKey({
        labOrganizationId: "lab-1",
        restorationType: "Crown",
        material: "anything",
        restorationSubtype: "restorative/crown_and_bridge/zirconia",
      }),
    ).resolves.toBe("lab_specific_zirconia");

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.arrayContaining([
          { column: catalogColumns.entryType, value: "material" },
          { column: catalogColumns.caseType, value: "restorative" },
          { column: catalogColumns.parentKey, value: "crown_and_bridge" },
          { column: catalogColumns.key, value: "zirconia" },
        ]),
      }),
    );
  });

  it("inherits a parent subtype override when the material has no override", async () => {
    findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ priceKeyOverride: "lab_specific_crown" });

    await expect(
      resolveRestorationPriceKey({
        labOrganizationId: "lab-1",
        restorationType: "Crown",
        material: "anything",
        restorationSubtype: "restorative/crown_and_bridge/zirconia",
      }),
    ).resolves.toBe("lab_specific_crown");

    expect(findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.arrayContaining([
          { column: catalogColumns.entryType, value: "subtype" },
          { column: catalogColumns.parentKey, value: "" },
          { column: catalogColumns.key, value: "crown_and_bridge" },
        ]),
      }),
    );
  });

  it("falls back to free-text matching when the hierarchy has no price key", async () => {
    await expect(
      resolveRestorationPriceKey({
        labOrganizationId: "lab-1",
        restorationType: "Implant",
        material: "Zirconia",
        restorationSubtype: "restorative/implant/resin",
      }),
    ).resolves.toBe("zirconia_crown");
  });

  it("keeps the materialless implant fallback intact", async () => {
    await expect(
      resolveRestorationPriceKey({
        labOrganizationId: "lab-1",
        restorationType: "Implant",
        material: null,
        restorationSubtype: "restorative/implant",
      }),
    ).resolves.toBe("implant");
  });

  it("does not change legacy PFZ matching", async () => {
    await expect(
      resolveRestorationPriceKey({
        labOrganizationId: "lab-1",
        restorationType: "Crown",
        material: "PFZ",
      }),
    ).resolves.toBe("zirconia_crown");
  });

  it("falls back when the catalog table error is wrapped by the database client", async () => {
    findFirst.mockRejectedValueOnce({
      cause: { code: "42P01" },
    });

    await expect(
      resolveRestorationPriceKey({
        labOrganizationId: "lab-1",
        restorationType: "Crown",
        material: "anything",
        restorationSubtype: "restorative/crown_and_bridge/zirconia",
      }),
    ).resolves.toBe("zirconia_crown");
  });
});