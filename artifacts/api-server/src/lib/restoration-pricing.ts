import { and, eq } from "drizzle-orm";
import { db, labCatalogEntries } from "@workspace/db";
import {
  deriveCaseHierarchy,
  getPricingKey,
  encodeCustomToken,
} from "@workspace/case-taxonomy";
import { materialToPriceKey } from "./material-mapping.js";

async function findCatalogEntry(args: {
  labOrganizationId: string;
  entryType: "subtype" | "material";
  caseType: string;
  parentKey: string;
  key: string;
}) {
  try {
    return await db.query.labCatalogEntries.findFirst({
      where: and(
        eq(labCatalogEntries.labOrganizationId, args.labOrganizationId),
        eq(labCatalogEntries.entryType, args.entryType),
        eq(labCatalogEntries.caseType, args.caseType),
        eq(labCatalogEntries.parentKey, args.parentKey),
        eq(labCatalogEntries.key, args.key),
      ),
    });
  } catch (error) {
    // The catalog table is introduced by the catalog foundation migration.
    // Keep older development databases usable for taxonomy/default pricing,
    // but do not hide unrelated database failures.
    const directCode =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const cause = error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
    const causeCode =
      cause && typeof cause === "object" && "code" in cause
        ? (cause as { code?: unknown }).code
        : undefined;
    if (directCode === "42P01" || causeCode === "42P01") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolve the fee-schedule key for one restoration.
 *
 * Structured restoration data is authoritative when present:
 * a lab catalog override wins first, followed by the static taxonomy mapping.
 * Legacy/free-form rows deliberately keep the old matcher unchanged.
 */
export async function resolveRestorationPriceKey(args: {
  labOrganizationId: string;
  material?: string | null;
  restorationType?: string | null;
  restorationSubtype?: string | null;
}): Promise<string | null> {
  const {
    labOrganizationId,
    material,
    restorationType,
    restorationSubtype,
  } = args;

  if (restorationSubtype) {
    const hierarchy = deriveCaseHierarchy(
      restorationType,
      restorationSubtype,
      material,
    );
    if (hierarchy.caseType) {
      const subtypeKey = hierarchy.subtype
        ?? (hierarchy.customSubtypeId
          ? encodeCustomToken(hierarchy.customSubtypeId)
          : null);
      const materialKey = hierarchy.materialSubtype
        ?? (hierarchy.customMaterialSubtypeId
          ? encodeCustomToken(hierarchy.customMaterialSubtypeId)
          : null);

      const entryType = materialKey ? "material" : "subtype";
      const parentKey = materialKey ? (subtypeKey ?? "") : "";
      const key = materialKey ?? subtypeKey;

      if (key) {
        const catalogRow = await findCatalogEntry({
          labOrganizationId,
          entryType,
          caseType: hierarchy.caseType,
          parentKey,
          key,
        });
        if (catalogRow?.priceKeyOverride?.trim()) {
          return catalogRow.priceKeyOverride.trim();
        }
      }

      // A material may inherit the lab's override for its parent subtype when
      // the lab has not customized that specific material leaf.
      if (materialKey && subtypeKey) {
        const parentCatalogRow = await findCatalogEntry({
          labOrganizationId,
          entryType: "subtype",
          caseType: hierarchy.caseType,
          parentKey: "",
          key: subtypeKey,
        });
        if (parentCatalogRow?.priceKeyOverride?.trim()) {
          return parentCatalogRow.priceKeyOverride.trim();
        }
      }

      const taxonomyKey = getPricingKey(hierarchy);
      if (taxonomyKey) return taxonomyKey;
    }
  }

  return materialToPriceKey(material, restorationType);
}