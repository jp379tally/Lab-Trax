/**
 * Lab Catalog — per-lab customization layer on top of the static
 * Case Type → Subtype → Material taxonomy (@workspace/case-taxonomy).
 *
 * A lab with zero `lab_catalog_entries` rows sees exactly the shared
 * built-in tree. Rows layer in additions (custom subtypes/materials),
 * renames (customs only — built-in labels never change), disables, and
 * reordering. Everything is merged at READ time by `getEffectiveCatalogTree`
 * — nothing is ever backfilled into per-lab rows, so uncustomized labs
 * carry zero migration risk.
 *
 * See `@workspace/case-taxonomy`'s `encodeCustomToken`/`isCustomToken`/
 * `parseCustomToken` for how a custom entry is referenced from a
 * `case_restorations.restorationSubtype` value.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, like, or } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  cases,
  caseRestorations,
  labCatalogEntries,
  labVocabulary,
  pricingTiers,
  type LabCatalogEntryRow,
} from "@workspace/db";
import {
  CASE_TAXONOMY,
  CASE_TYPES,
  encodeCustomToken,
  getMaterialSubtypeLabel,
  getMaterialSubtypes,
  getSubtypeLabel,
  getSubtypes,
  isValidCaseType,
  isValidSubtype,
  type CaseType,
  type CaseTypeEntry,
} from "@workspace/case-taxonomy";
import { DEFAULT_TIER_KEYS } from "./material-mapping.js";
import { fetchLabItemLabels } from "./pricing.js";
import { HttpError } from "./http.js";
import { notDeleted } from "./soft-delete.js";

/** Sentinel `parentKey` for rows whose parent is the case type itself (not
 * a literal `null`, so the natural-key unique index — and any upsert
 * against it — actually dedupes; Postgres treats every NULL as distinct). */
const ROOT_PARENT_KEY = "";

export type CatalogEntryType = "subtype" | "material";

// ─────────────────────────── Effective tree ────────────────────────────────

export interface EffectiveMaterialNode {
  /** Catalog row id backing this node, or null for an untouched built-in. */
  id: string | null;
  /** Literal taxonomy key, or a `custom:<id>` token for a lab-added entry. */
  key: string;
  label: string;
  isCustom: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Effective pricing key: override (if set) else the static default. */
  priceKey: string | null;
}

export interface EffectiveSubtypeNode {
  id: string | null;
  key: string;
  label: string;
  isCustom: boolean;
  isActive: boolean;
  sortOrder: number;
  priceKey: string | null;
  materials: EffectiveMaterialNode[];
}

export interface EffectiveCaseTypeNode {
  /** Case types are fixed and never carry a catalog row. */
  key: CaseType;
  label: string;
  subtypes: EffectiveSubtypeNode[];
}

export interface EffectiveCatalogTree {
  labOrganizationId: string;
  caseTypes: EffectiveCaseTypeNode[];
}

async function fetchLabCatalogRows(
  labOrganizationId: string,
): Promise<LabCatalogEntryRow[]> {
  return db.query.labCatalogEntries.findMany({
    where: eq(labCatalogEntries.labOrganizationId, labOrganizationId),
  });
}

function sortNodes<T extends { sortOrder: number; label: string }>(
  nodes: T[],
): T[] {
  return [...nodes].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.label.localeCompare(b.label);
  });
}

/**
 * Build the effective Case Type → Subtype → Material tree for a lab by
 * merging the static taxonomy with that lab's `lab_catalog_entries` rows.
 * Computed fresh on every call — never persisted per lab.
 */
export async function getEffectiveCatalogTree(
  labOrganizationId: string,
  options: { includeInactive?: boolean } = {},
): Promise<EffectiveCatalogTree> {
  const includeInactive = options.includeInactive ?? true;
  const rows = await fetchLabCatalogRows(labOrganizationId);

  const subtypeOverrides = new Map<string, LabCatalogEntryRow>(); // key: `${caseType}::${key}`
  const customSubtypes = new Map<CaseType, LabCatalogEntryRow[]>();
  const materialOverrides = new Map<string, LabCatalogEntryRow>(); // key: `${caseType}::${parentKey}::${key}`
  const customMaterialsByParent = new Map<string, LabCatalogEntryRow[]>(); // key: `${caseType}::${parentKey}`

  for (const row of rows) {
    const caseType = row.caseType as CaseType;
    if (row.entryType === "subtype") {
      if (row.isCustom) {
        const list = customSubtypes.get(caseType) ?? [];
        list.push(row);
        customSubtypes.set(caseType, list);
      } else {
        subtypeOverrides.set(`${caseType}::${row.key}`, row);
      }
    } else if (row.entryType === "material") {
      if (row.isCustom) {
        const parentMapKey = `${caseType}::${row.parentKey}`;
        const list = customMaterialsByParent.get(parentMapKey) ?? [];
        list.push(row);
        customMaterialsByParent.set(parentMapKey, list);
      } else {
        materialOverrides.set(`${caseType}::${row.parentKey}::${row.key}`, row);
      }
    }
    // entryType "case_type" rows are never created by the API; ignored here
    // defensively so a stray row can never leak into the tree.
  }

  function buildMaterialsForSubtype(
    caseType: CaseType,
    subtypeKey: string,
    staticMaterialKeys: string[],
    staticLabelAndPrice: (key: string) => { label: string; pricingKey: string | null },
  ): EffectiveMaterialNode[] {
    const nodes: EffectiveMaterialNode[] = [];

    staticMaterialKeys.forEach((key, index) => {
      const override = materialOverrides.get(`${caseType}::${subtypeKey}::${key}`);
      const { label, pricingKey } = staticLabelAndPrice(key);
      const isActive = override?.isActive ?? true;
      if (!includeInactive && !isActive) return;
      nodes.push({
        id: override?.id ?? null,
        key,
        label,
        isCustom: false,
        isActive,
        sortOrder: override?.sortOrder ?? index,
        priceKey: override?.priceKeyOverride ?? pricingKey,
      });
    });

    const customList = customMaterialsByParent.get(`${caseType}::${subtypeKey}`) ?? [];
    for (const row of customList) {
      if (!includeInactive && !row.isActive) continue;
      nodes.push({
        id: row.id,
        key: row.key,
        label: row.label,
        isCustom: true,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        priceKey: row.priceKeyOverride,
      });
    }

    return sortNodes(nodes);
  }

  const caseTypes: EffectiveCaseTypeNode[] = CASE_TYPES.map((ct) => {
    const ctEntry = CASE_TAXONOMY[ct] as CaseTypeEntry;
    const staticSubtypeKeys = getSubtypes(ct);

    const subtypeNodes: EffectiveSubtypeNode[] = [];

    staticSubtypeKeys.forEach((stKey, index) => {
      const override = subtypeOverrides.get(`${ct}::${stKey}`);
      const isActive = override?.isActive ?? true;
      if (includeInactive || isActive) {
        subtypeNodes.push({
          id: override?.id ?? null,
          key: stKey,
          label: getSubtypeLabel(ct, stKey),
          isCustom: false,
          isActive,
          sortOrder: override?.sortOrder ?? index,
          priceKey: override?.priceKeyOverride ?? null,
          materials: buildMaterialsForSubtype(
            ct,
            stKey,
            getMaterialSubtypes(ct, stKey),
            (msKey) => ({
              label: getMaterialSubtypeLabel(ct, stKey, msKey as any),
              pricingKey:
                (ctEntry.subtypes[stKey]?.materialSubtypes as any)?.[msKey]
                  ?.pricingKey ?? null,
            }),
          ),
        });
      }
    });

    const customList = customSubtypes.get(ct) ?? [];
    for (const row of customList) {
      if (!includeInactive && !row.isActive) continue;
      subtypeNodes.push({
        id: row.id,
        key: row.key,
        label: row.label,
        isCustom: true,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        priceKey: row.priceKeyOverride,
        // Custom subtypes have no static materials — only custom material
        // rows parented to this row's own `custom:<id>` key.
        materials: buildMaterialsForSubtype(ct, row.key, [], () => ({
          label: "",
          pricingKey: null,
        })),
      });
    }

    return {
      key: ct,
      label: ctEntry.label,
      subtypes: sortNodes(subtypeNodes),
    };
  });

  return { labOrganizationId, caseTypes };
}

// ────────────────────────── Sort-order helpers ─────────────────────────────

/**
 * Compute the sortOrder a newly-created sibling should default to (append
 * at the end of the sibling list), given the parent's current effective
 * children (already-sorted, ascending). Callers pass whichever list
 * (subtypes of a case type, or materials of a subtype) is relevant.
 */
function nextSortOrder(siblings: Array<{ sortOrder: number }>): number {
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((s) => s.sortOrder)) + 1;
}

// ────────────────────────── Price-key validation ───────────────────────────

/**
 * All price keys considered valid for a lab: the static default tier keys,
 * plus any key already used in one of the lab's (non-deleted) pricing
 * tiers, plus any key with a configured custom label. Mirrors the ad-hoc
 * set assembled by `POST /pricing/add-item`.
 */
export async function getValidPriceKeysForLab(
  labOrganizationId: string,
): Promise<Set<string>> {
  const keys = new Set<string>(DEFAULT_TIER_KEYS as readonly string[]);
  const tiers = await db.query.pricingTiers.findMany({
    where: and(
      eq(pricingTiers.labOrganizationId, labOrganizationId),
      notDeleted(pricingTiers),
    ),
  });
  for (const tier of tiers) {
    for (const key of Object.keys((tier.pricesJson ?? {}) as Record<string, unknown>)) {
      keys.add(key);
    }
  }
  const labels = await fetchLabItemLabels(labOrganizationId);
  for (const key of Object.keys(labels)) keys.add(key);
  return keys;
}

/** Throws HttpError(400) when `priceKeyOverride` is set but not a known
 * price key for this lab. A null/undefined override is always valid (it
 * means "no override"). */
export async function validatePriceKeyOverride(
  labOrganizationId: string,
  priceKeyOverride: string | null | undefined,
): Promise<void> {
  if (priceKeyOverride === null || priceKeyOverride === undefined) return;
  const trimmed = priceKeyOverride.trim();
  if (!trimmed) {
    throw new HttpError(400, "priceKeyOverride must not be blank; omit or pass null to clear it.");
  }
  const valid = await getValidPriceKeysForLab(labOrganizationId);
  if (!valid.has(trimmed)) {
    throw new HttpError(
      400,
      `"${trimmed}" is not a known pricing key for this lab.`,
    );
  }
}

// ───────────────────────── Create / mutate customs ─────────────────────────

export interface CreateCustomEntryInput {
  labOrganizationId: string;
  entryType: CatalogEntryType;
  caseType: string;
  /** Required (and validated) when entryType === "material"; ignored/rejected when "subtype". */
  parentKey?: string | null;
  label: string;
  isActive?: boolean;
  sortOrder?: number;
  priceKeyOverride?: string | null;
  createdByUserId: string;
}

/**
 * Resolve+validate the parent of a new/edited material: either a literal
 * built-in subtype key of `caseType`, or a `custom:<id>` token referencing
 * an existing custom subtype row in the same lab. Throws HttpError on any
 * mismatch so callers get a precise 400/404.
 */
async function resolveMaterialParent(
  labOrganizationId: string,
  caseType: CaseType,
  parentKey: string,
): Promise<{ parentIsCustom: boolean }> {
  if (isValidSubtype(parentKey)) {
    if (!getSubtypes(caseType).includes(parentKey as any)) {
      throw new HttpError(
        400,
        `"${parentKey}" is not a subtype of case type "${caseType}".`,
      );
    }
    return { parentIsCustom: false };
  }
  const parentRow = await db.query.labCatalogEntries.findFirst({
    where: and(
      eq(labCatalogEntries.labOrganizationId, labOrganizationId),
      eq(labCatalogEntries.entryType, "subtype"),
      eq(labCatalogEntries.caseType, caseType),
      eq(labCatalogEntries.key, parentKey),
      eq(labCatalogEntries.isCustom, true),
    ),
  });
  if (!parentRow) {
    throw new HttpError(404, `Parent subtype "${parentKey}" was not found in this lab's catalog.`);
  }
  return { parentIsCustom: true };
}

/** Create a custom subtype or material entry (never a case type). */
export async function createCustomCatalogEntry(
  input: CreateCustomEntryInput,
): Promise<LabCatalogEntryRow> {
  if (!isValidCaseType(input.caseType)) {
    throw new HttpError(400, `"${input.caseType}" is not a valid case type.`);
  }
  const caseType = input.caseType as CaseType;
  const label = input.label.trim();
  if (!label) throw new HttpError(400, "label must not be blank.");

  await validatePriceKeyOverride(input.labOrganizationId, input.priceKeyOverride);

  const id = randomUUID();
  const key = encodeCustomToken(id);

  let parentKey: string;
  if (input.entryType === "subtype") {
    if (input.parentKey) {
      throw new HttpError(400, "parentKey is not allowed when creating a subtype.");
    }
    parentKey = ROOT_PARENT_KEY;
  } else {
    if (!input.parentKey) {
      throw new HttpError(400, "parentKey is required when creating a material.");
    }
    await resolveMaterialParent(input.labOrganizationId, caseType, input.parentKey);
    parentKey = input.parentKey;
  }

  // Default sortOrder = end of the current effective sibling list.
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const tree = await getEffectiveCatalogTree(input.labOrganizationId, {
      includeInactive: true,
    });
    const ctNode = tree.caseTypes.find((c) => c.key === caseType)!;
    if (input.entryType === "subtype") {
      sortOrder = nextSortOrder(ctNode.subtypes);
    } else {
      const parentNode = ctNode.subtypes.find((s) => s.key === parentKey);
      sortOrder = nextSortOrder(parentNode?.materials ?? []);
    }
  }

  const [row] = await db
    .insert(labCatalogEntries)
    .values({
      id,
      labOrganizationId: input.labOrganizationId,
      entryType: input.entryType,
      caseType,
      parentKey,
      key,
      label,
      isCustom: true,
      isActive: input.isActive ?? true,
      sortOrder,
      priceKeyOverride: input.priceKeyOverride ?? null,
      createdByUserId: input.createdByUserId,
    })
    .returning();
  return row;
}

export interface UpdateCustomEntryInput {
  label?: string;
  isActive?: boolean;
  sortOrder?: number;
  priceKeyOverride?: string | null;
}

/** Update a custom entry (label/active/sortOrder/priceKeyOverride). Rejects built-ins. */
export async function updateCustomCatalogEntry(
  row: LabCatalogEntryRow,
  input: UpdateCustomEntryInput,
): Promise<LabCatalogEntryRow> {
  if (!row.isCustom) {
    throw new HttpError(
      400,
      "This is a built-in catalog entry. Use PATCH /catalog/builtin-overrides to change it (built-ins may only be disabled or reordered).",
    );
  }
  if (input.priceKeyOverride !== undefined) {
    await validatePriceKeyOverride(row.labOrganizationId, input.priceKeyOverride);
  }
  const trimmedLabel = input.label !== undefined ? input.label.trim() : undefined;
  if (trimmedLabel !== undefined && !trimmedLabel) {
    throw new HttpError(400, "label must not be blank.");
  }

  const [updated] = await db
    .update(labCatalogEntries)
    .set({
      ...(trimmedLabel !== undefined ? { label: trimmedLabel } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.priceKeyOverride !== undefined
        ? { priceKeyOverride: input.priceKeyOverride }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(labCatalogEntries.id, row.id))
    .returning();
  return updated;
}

export interface BuiltinOverrideInput {
  labOrganizationId: string;
  entryType: CatalogEntryType;
  caseType: string;
  parentKey?: string | null;
  key: string;
  isActive?: boolean;
  sortOrder?: number;
  priceKeyOverride?: string | null;
  createdByUserId: string;
}

/** Static index of a built-in key among its siblings, used as the default
 * sortOrder the first time an override row is created for it. */
function staticIndexOf(caseType: CaseType, entryType: CatalogEntryType, parentKey: string, key: string): number {
  if (entryType === "subtype") {
    return getSubtypes(caseType).indexOf(key as any);
  }
  return getMaterialSubtypes(caseType, parentKey as any).indexOf(key as any);
}

/**
 * Upsert-by-natural-key an override row for a BUILT-IN subtype or material
 * (never a custom entry, never a case type). Only isActive / sortOrder /
 * priceKeyOverride are ever accepted — label is intentionally not part of
 * the input type, since built-in labels are immutable.
 */
export async function upsertBuiltinOverride(
  input: BuiltinOverrideInput,
): Promise<LabCatalogEntryRow> {
  if (!isValidCaseType(input.caseType)) {
    throw new HttpError(400, `"${input.caseType}" is not a valid case type.`);
  }
  const caseType = input.caseType as CaseType;

  await validatePriceKeyOverride(input.labOrganizationId, input.priceKeyOverride);

  let parentKey: string;
  let label: string;
  if (input.entryType === "subtype") {
    if (input.parentKey) {
      throw new HttpError(400, "parentKey is not allowed for a subtype override.");
    }
    if (!getSubtypes(caseType).includes(input.key as any)) {
      throw new HttpError(400, `"${input.key}" is not a built-in subtype of "${caseType}".`);
    }
    parentKey = ROOT_PARENT_KEY;
    label = getSubtypeLabel(caseType, input.key as any);
  } else {
    if (!input.parentKey || !isValidSubtype(input.parentKey)) {
      throw new HttpError(
        400,
        "A built-in material override requires parentKey to be a built-in subtype key (custom subtypes' materials are created via POST /catalog/entries instead).",
      );
    }
    if (!getMaterialSubtypes(caseType, input.parentKey as any).includes(input.key as any)) {
      throw new HttpError(
        400,
        `"${input.key}" is not a built-in material of "${caseType}/${input.parentKey}".`,
      );
    }
    parentKey = input.parentKey;
    label = getMaterialSubtypeLabel(caseType, input.parentKey as any, input.key as any);
  }

  const defaultSortOrder = staticIndexOf(caseType, input.entryType, parentKey, input.key);

  const existing = await db.query.labCatalogEntries.findFirst({
    where: and(
      eq(labCatalogEntries.labOrganizationId, input.labOrganizationId),
      eq(labCatalogEntries.entryType, input.entryType),
      eq(labCatalogEntries.caseType, caseType),
      eq(labCatalogEntries.parentKey, parentKey),
      eq(labCatalogEntries.key, input.key),
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(labCatalogEntries)
      .set({
        label,
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.priceKeyOverride !== undefined
          ? { priceKeyOverride: input.priceKeyOverride }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(labCatalogEntries.id, existing.id))
      .returning();
    return updated;
  }

  try {
    const [inserted] = await db
      .insert(labCatalogEntries)
      .values({
        labOrganizationId: input.labOrganizationId,
        entryType: input.entryType,
        caseType,
        parentKey,
        key: input.key,
        label,
        isCustom: false,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? defaultSortOrder,
        priceKeyOverride: input.priceKeyOverride ?? null,
        createdByUserId: input.createdByUserId,
      })
      .returning();
    return inserted;
  } catch (err) {
    // Rare race: another request created the row between our findFirst and
    // insert. Fall back to an update against the now-existing row.
    const retry = await db.query.labCatalogEntries.findFirst({
      where: and(
        eq(labCatalogEntries.labOrganizationId, input.labOrganizationId),
        eq(labCatalogEntries.entryType, input.entryType),
        eq(labCatalogEntries.caseType, caseType),
        eq(labCatalogEntries.parentKey, parentKey),
        eq(labCatalogEntries.key, input.key),
      ),
    });
    if (!retry) throw err;
    const [updated] = await db
      .update(labCatalogEntries)
      .set({
        label,
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.priceKeyOverride !== undefined
          ? { priceKeyOverride: input.priceKeyOverride }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(labCatalogEntries.id, retry.id))
      .returning();
    return updated;
  }
}

// ─────────────────────────── Delete (customs only) ─────────────────────────

/**
 * Count how many `case_restorations` rows in this lab reference a custom
 * catalog entry's token.
 *
 * `case_restorations.restorationSubtype` encodes `"<caseType>/<subtype-or-
 * custom-token>[/<material-or-custom-token>]"` (see @workspace/case-taxonomy).
 * For a custom SUBTYPE, matching the exact `"<caseType>/<key>"` value or the
 * `"<caseType>/<key>/%"` prefix also transitively counts usage of any custom
 * MATERIAL child (its encoded value always starts with that same prefix), so
 * no separate child lookup is needed here for usage counting.
 *
 * Legacy `lab_cases` blob rows are NOT scanned: the legacy JSON shape has no
 * `restorationSubtype`-equivalent field at all (every legacy→canonical
 * translation path hardcodes it to null), so a custom token can never appear
 * there — unlike `lab_vocabulary`'s free-text fields, which the legacy blob
 * does carry and vocabulary's own delete guard scans for that reason.
 */
async function countCustomEntryUsage(
  row: LabCatalogEntryRow,
): Promise<number> {
  const caseType = row.caseType;
  const condition =
    row.entryType === "subtype"
      ? or(
          eq(caseRestorations.restorationSubtype, `${caseType}/${row.key}`),
          like(caseRestorations.restorationSubtype, `${caseType}/${row.key}/%`),
        )
      : like(caseRestorations.restorationSubtype, `%/${row.key}`);

  const [usageRow] = await db
    .select({ usageCount: count() })
    .from(caseRestorations)
    .innerJoin(cases, eq(caseRestorations.caseId, cases.id))
    .where(and(eq(cases.labOrganizationId, row.labOrganizationId), condition));
  return usageRow?.usageCount ?? 0;
}

export interface DeleteCustomEntryResult {
  deleted: boolean;
  usageCount: number;
  cascadedMaterialCount: number;
}

/**
 * Delete a custom catalog entry, guarded against in-use entries (mirroring
 * `lab_vocabulary`'s delete guard), with a `force` override. Deleting a
 * custom subtype cascades to its custom material children.
 *
 * On a blocked delete (in use, no force) this returns `{ deleted: false,
 * usageCount, cascadedMaterialCount: 0 }` rather than throwing, so the route
 * can format the same `{ ok: false, error, usageCount }` 409 body the
 * existing `lab_vocabulary` delete guard returns. Rejecting a built-in
 * (non-custom) row is a genuine hard error and still throws.
 */
export async function deleteCustomCatalogEntry(
  row: LabCatalogEntryRow,
  force: boolean,
): Promise<DeleteCustomEntryResult> {
  if (!row.isCustom) {
    throw new HttpError(
      400,
      "Built-in catalog entries cannot be deleted. Disable them instead via PATCH /catalog/builtin-overrides.",
    );
  }

  const usageCount = await countCustomEntryUsage(row);
  if (usageCount > 0 && !force) {
    return { deleted: false, usageCount, cascadedMaterialCount: 0 };
  }

  let cascadedMaterialCount = 0;
  if (row.entryType === "subtype") {
    const children = await db.query.labCatalogEntries.findMany({
      where: and(
        eq(labCatalogEntries.labOrganizationId, row.labOrganizationId),
        eq(labCatalogEntries.entryType, "material"),
        eq(labCatalogEntries.isCustom, true),
        eq(labCatalogEntries.parentKey, row.key),
      ),
    });
    cascadedMaterialCount = children.length;
    await db.transaction(async (tx) => {
      if (children.length > 0) {
        await tx.delete(labCatalogEntries).where(
          and(
            eq(labCatalogEntries.labOrganizationId, row.labOrganizationId),
            eq(labCatalogEntries.entryType, "material"),
            eq(labCatalogEntries.isCustom, true),
            eq(labCatalogEntries.parentKey, row.key),
          ),
        );
      }
      await tx.delete(labCatalogEntries).where(eq(labCatalogEntries.id, row.id));
    });
  } else {
    await db.delete(labCatalogEntries).where(eq(labCatalogEntries.id, row.id));
  }

  return { deleted: true, usageCount, cascadedMaterialCount };
}

// ──────────────────────── Legacy-vocabulary review ─────────────────────────

/**
 * Curated starting signal for `lab_vocabulary` "material" entries that are
 * really subtypes or services rather than materials. Exact, case-insensitive
 * match against free-text values labs have historically typed in. This is
 * intentionally a simple heuristic (per the task spec) — extend the list as
 * more mis-filed terms are identified; it never renames, moves, or deletes
 * anything on its own.
 */
export const LEGACY_PROBLEM_TERMS: Array<{ term: string; reason: string }> = [
  {
    term: "Implant",
    reason: "This is a case subtype (Restorative → Implant), not a material.",
  },
  {
    term: "Diagnostic Wax Up",
    reason: "This describes a service/procedure, not a material.",
  },
  {
    term: "Combo",
    reason: "This describes a case combining multiple restoration types, not a material.",
  },
  {
    term: "PFZ",
    reason:
      "This names a crown construction method; the catalog already has a PFZ material (Crown & Bridge / Implant) that resolves to the zirconia price key.",
  },
  {
    term: "Silver",
    reason: "This looks like a cast-metal/alloy descriptor rather than a distinct material.",
  },
];

export interface LegacyVocabularyReviewCandidate {
  id: string;
  value: string;
  matchedTerm: string;
  reason: string;
}

/**
 * Compute (read-only) which of a lab's `lab_vocabulary` "material" entries
 * look like mis-filed subtypes/services. Never writes anything — the result
 * powers a human-in-the-loop review flow (a follow-up task's admin UI).
 */
export async function computeLegacyVocabularyReview(
  labOrganizationId: string,
): Promise<LegacyVocabularyReviewCandidate[]> {
  const rows = await db.query.labVocabulary.findMany({
    where: and(
      eq(labVocabulary.labOrganizationId, labOrganizationId),
      eq(labVocabulary.kind, "material"),
    ),
  });

  const termsByLower = new Map(
    LEGACY_PROBLEM_TERMS.map((t) => [t.term.toLowerCase(), t] as const),
  );

  const candidates: LegacyVocabularyReviewCandidate[] = [];
  for (const row of rows) {
    const match = termsByLower.get(row.value.trim().toLowerCase());
    if (match) {
      candidates.push({
        id: row.id,
        value: row.value,
        matchedTerm: match.term,
        reason: match.reason,
      });
    }
  }
  return candidates;
}
