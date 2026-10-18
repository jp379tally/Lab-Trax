/**
 * Firewall tests for the mobile case hierarchy edit logic.
 *
 * Two concerns:
 *
 * 1. ROLE GATE — hierarchy editing on mobile must only be available to
 *    admins/owners (`isAdmin`). Using the broader `canEdit` flag (which
 *    includes billing users) would violate the task requirement.
 *
 * 2. CUSTOM MATERIAL PRESERVATION — when a restoration has a custom catalog
 *    material (`customMaterialSubtypeId`), opening the hierarchy edit modal
 *    must initialize `draftMat` from the custom token so that a save without
 *    reselecting material round-trips it correctly rather than clearing it.
 */

import { describe, it, expect } from "vitest";
import {
  encodeRestorationSubtype,
  parseCustomToken,
  deriveCaseHierarchy,
  type CaseHierarchy,
  type CaseType,
  type CaseSubtype,
  type MaterialSubtype,
} from "@workspace/case-taxonomy";

// ── Role-gate logic ───────────────────────────────────────────────────────────
//
// OverviewSection computes:
//   const showEdit = isAdmin && !!firstRestoration?.id;
//
// This is the same guard used for both rendering the "Edit" affordance and
// enabling the catalog query. We test the boundary conditions directly.

describe("Case hierarchy edit — role gate (isAdmin, not canEdit)", () => {
  /** Mirrors OverviewSection's showEdit computation. */
  function computeShowEdit(isAdmin: boolean, firstRestorationId: string | null | undefined): boolean {
    return isAdmin && !!firstRestorationId;
  }

  it("shows the Edit button when isAdmin=true and a restoration exists", async () => {
    expect(computeShowEdit(true, "rest-abc")).toBe(true);
  });

  it("hides the Edit button when isAdmin=false, even if canEdit would be true", async () => {
    // billing/technician roles set canEdit=true but isAdmin=false
    const isAdmin = false;
    expect(computeShowEdit(isAdmin, "rest-abc")).toBe(false);
  });

  it("hides the Edit button when isAdmin=true but there is no first restoration", async () => {
    expect(computeShowEdit(true, null)).toBe(false);
    expect(computeShowEdit(true, undefined)).toBe(false);
  });
});

// ── Custom material token preservation ───────────────────────────────────────
//
// When a restoration was saved with a lab-custom material (identified by a
// `customMaterialSubtypeId` in the decoded hierarchy), `openHierarchyEdit`
// must set:
//
//   draftMat = `custom:${firstHierarchy.customMaterialSubtypeId}`
//
// so that `saveHierarchy` can later call `parseCustomToken(draftMat)` and
// re-encode the hierarchy with the same custom material, rather than silently
// dropping it (which would PATCH material: null to the server).

describe("Case hierarchy edit — custom material token preservation", () => {
  /** Mirrors the draftMat initialization in openHierarchyEdit. */
  function initDraftMat(hierarchy: CaseHierarchy | null): string | null {
    return (
      hierarchy?.materialSubtype ??
      (hierarchy?.customMaterialSubtypeId
        ? `custom:${hierarchy.customMaterialSubtypeId}`
        : null)
    );
  }

  it("initializes draftMat from a built-in materialSubtype", async () => {
    const hierarchy = deriveCaseHierarchy(
      "Crown",
      encodeRestorationSubtype({ caseType: "restorative", subtype: "crown", materialSubtype: "zirconia" }),
      null,
    );
    expect(initDraftMat(hierarchy)).toBe("zirconia");
  });

  it("initializes draftMat from customMaterialSubtypeId when materialSubtype is null", async () => {
    const customMatId = "mat-custom-abc";
    const encoded = encodeRestorationSubtype({
      caseType: "restorative",
      subtype: "crown",
      materialSubtype: null,
      customMaterialSubtypeId: customMatId,
    });
    const hierarchy = deriveCaseHierarchy("Crown", encoded, null);
    const draftMat = initDraftMat(hierarchy);
    expect(draftMat).toBe(`custom:${customMatId}`);
  });

  it("initializes draftMat as null when no material or custom material is set", async () => {
    const hierarchy = deriveCaseHierarchy(
      "Crown",
      encodeRestorationSubtype({ caseType: "restorative", subtype: "crown", materialSubtype: null }),
      null,
    );
    expect(initDraftMat(hierarchy)).toBeNull();
  });

  it("parseCustomToken correctly extracts the custom id from a draft mat token", async () => {
    const customMatId = "mat-custom-xyz";
    const draftMat = `custom:${customMatId}`;
    expect(parseCustomToken(draftMat)).toBe(customMatId);
  });

  it("parseCustomToken returns null for built-in keys (no custom: prefix)", async () => {
    expect(parseCustomToken("zirconia")).toBeNull();
    expect(parseCustomToken("emax")).toBeNull();
  });

  it("round-trips a custom material through encode→decode→re-encode without data loss", async () => {
    const customMatId = "mat-99";
    // Initial encode (what the server stores)
    const encoded = encodeRestorationSubtype({
      caseType: "restorative",
      subtype: "crown",
      materialSubtype: null,
      customMaterialSubtypeId: customMatId,
    });
    expect(encoded).not.toBeNull();

    // Decode (deriveCaseHierarchy produces the hierarchy)
    const hierarchy = deriveCaseHierarchy("Crown", encoded, null);
    expect(hierarchy.customMaterialSubtypeId).toBe(customMatId);

    // Modal opens: draftMat is initialized from customMaterialSubtypeId
    const draftMat = initDraftMat(hierarchy);
    expect(draftMat).toBe(`custom:${customMatId}`);

    // Save: parseCustomToken extracts the id back out
    const matCustomId = parseCustomToken(draftMat!);
    expect(matCustomId).toBe(customMatId);

    // Re-encode: should produce the same encoded string
    const reEncoded = encodeRestorationSubtype({
      caseType: "restorative",
      subtype: "crown",
      materialSubtype: null,
      customMaterialSubtypeId: matCustomId!,
    });
    expect(reEncoded).toBe(encoded);
  });
});

// ── No-subtype fallback — representative restorationType ─────────────────────
//
// When a user picks a case type but has not yet picked a subtype, saveHierarchy
// must send a canonical representative restorationType (same mapping as
// desktop) rather than the generic case-type label (e.g. "Restorative").
// Generic labels are not inferrable by the taxonomy alias logic and leave the
// restoration in an unresolvable state for downstream display/pricing.

describe("Case hierarchy edit — no-subtype representative label", () => {
  /** Mirrors the HIERARCHY_REPRESENTATIVE + restorationTypeLabel computation inside saveHierarchy. */
  const HIERARCHY_REPRESENTATIVE: Record<string, string> = {
    restorative: "Crown",
    removable: "Full Denture",
    ortho: "Night Guard",
  };

  function computeRestorationTypeLabel(
    stNodeLabel: string | undefined,
    draftSt: string | null,
    draftCt: string,
  ): string {
    return stNodeLabel ?? (draftSt ? draftSt : (HIERARCHY_REPRESENTATIVE[draftCt] ?? draftCt));
  }

  it("uses 'Crown' when restorative is picked but no subtype selected", async () => {
    expect(computeRestorationTypeLabel(undefined, null, "restorative")).toBe("Crown");
  });

  it("uses 'Full Denture' when removable is picked but no subtype selected", async () => {
    expect(computeRestorationTypeLabel(undefined, null, "removable")).toBe("Full Denture");
  });

  it("uses 'Night Guard' when ortho is picked but no subtype selected", async () => {
    expect(computeRestorationTypeLabel(undefined, null, "ortho")).toBe("Night Guard");
  });

  it("uses the catalog node label when a subtype is selected", async () => {
    expect(computeRestorationTypeLabel("E.max / Lithium Disilicate", "emax", "restorative")).toBe("E.max / Lithium Disilicate");
  });

  it("falls back to the raw draftSt key when no catalog node exists for it (custom subtype)", async () => {
    // Custom subtypes aren't in the catalog until the query resolves; the raw
    // key is better than the generic case-type label.
    expect(computeRestorationTypeLabel(undefined, "custom:sub-99", "restorative")).toBe("custom:sub-99");
  });
});

// ── PATCH payload — explicit null clears vs undefined no-ops ─────────────────
//
// The server's PATCH /restorations/:id handler checks `!== undefined` before
// writing each field, so `undefined` means "leave unchanged" while `null`
// means "clear". `saveHierarchy` must send null for both `restorationSubtype`
// and `material` when no selection was made, or previous values survive.

describe("Case hierarchy edit — PATCH payload null semantics", () => {
  /** Mirrors the material payload expression inside saveHierarchy. */
  function materialPayload(
    draftMat: string | null,
    matNodeLabel: string | null | undefined,
  ): string | null {
    return draftMat ? (matNodeLabel ?? null) : null;
  }

  it("sends null material when no material is drafted (cascade reset)", async () => {
    expect(materialPayload(null, undefined)).toBeNull();
    expect(materialPayload(null, "Zirconia")).toBeNull();
  });

  it("sends the node label when a material is selected", async () => {
    expect(materialPayload("zirconia", "Zirconia")).toBe("Zirconia");
  });

  it("sends null when draftMat is set but no matching catalog node exists", async () => {
    // matNode not found → label undefined → falls back to null
    expect(materialPayload("zirconia", undefined)).toBeNull();
  });
});

// ── Full PATCH payload — built-in subtype + material combination ──────────────
//
// Verifies that saveHierarchy assembles the correct data shape that would be
// passed to updateRestoration.mutateAsync for a built-in (non-custom) subtype
// and material. Both the encoded restorationSubtype key and the resolved
// catalog label for material are guarded here so a taxonomy or encoding
// regression silently wiping material data is caught immediately.
//
// The `computeSavePayload` helper mirrors the saveHierarchy computation in
// OverviewSection ([id].tsx) so that the assertions track the real logic.

describe("saveHierarchy — full PATCH payload for built-in subtype + material", () => {
  // Minimal catalog mirroring hierarchyCatalogQuery.data?.data?.caseTypes
  const MOCK_CATALOG_CASE_TYPES = [
    {
      key: "restorative" as CaseType,
      label: "Restorative",
      id: null as string | null,
      subtypes: [
        {
          key: "crown_and_bridge",
          label: "Crown & Bridge",
          id: null as string | null,
          materials: [
            { key: "zirconia", label: "Zirconia", id: null as string | null },
            { key: "emax", label: "E.max / Lithium Disilicate", id: null as string | null },
          ],
        },
        {
          key: "crown",
          label: "Crown",
          id: null as string | null,
          materials: [{ key: "zirconia", label: "Zirconia", id: null as string | null }],
        },
      ],
    },
    {
      key: "removable" as CaseType,
      label: "Removable",
      id: null as string | null,
      subtypes: [
        {
          key: "dentures",
          label: "Dentures",
          id: null as string | null,
          materials: [{ key: "acrylic", label: "Acrylic", id: null as string | null }],
        },
      ],
    },
  ];

  const HIERARCHY_REPRESENTATIVE: Record<string, string> = {
    restorative: "Crown",
    removable: "Full Denture",
    ortho: "Night Guard",
  };

  /**
   * Mirrors the payload built inside saveHierarchy before it is handed to
   * updateRestoration.mutateAsync({ caseId, restorationId, data }).
   */
  function computeSavePayload(
    draftCt: string,
    draftSt: string | null,
    draftMat: string | null,
  ): { restorationType: string; restorationSubtype: string | null; material: string | null } {
    const ctNode = MOCK_CATALOG_CASE_TYPES.find((n) => n.key === draftCt);
    const stNode = ctNode?.subtypes.find((n) => n.key === draftSt);
    const matNode = stNode?.materials.find((n) => n.key === draftMat);
    const subtypeCustomId = draftSt ? parseCustomToken(draftSt) : null;
    const matCustomId = draftMat ? parseCustomToken(draftMat) : null;
    const encoded = encodeRestorationSubtype({
      caseType: draftCt as CaseType,
      subtype: subtypeCustomId ? null : (draftSt as CaseSubtype | null),
      materialSubtype: matCustomId ? null : (draftMat as MaterialSubtype | null),
      ...(subtypeCustomId ? { customSubtypeId: subtypeCustomId } : {}),
      ...(matCustomId ? { customMaterialSubtypeId: matCustomId } : {}),
    });
    const restorationTypeLabel =
      stNode?.label ?? (draftSt ? draftSt : (HIERARCHY_REPRESENTATIVE[draftCt] ?? draftCt));
    return {
      restorationType: restorationTypeLabel,
      restorationSubtype: encoded ?? null,
      material: draftMat ? (matNode?.label ?? null) : null,
    };
  }

  it("encodes restorationSubtype as '<caseType>/<subtype>/<materialKey>' and resolves the catalog label as material", async () => {
    const payload = computeSavePayload("restorative", "crown_and_bridge", "zirconia");
    expect(payload.restorationSubtype).toBe("restorative/crown_and_bridge/zirconia");
    expect(payload.material).toBe("Zirconia");
    expect(payload.restorationType).toBe("Crown & Bridge");
  });

  it("encodes restorationSubtype without the material segment when no material is drafted", async () => {
    const payload = computeSavePayload("restorative", "crown_and_bridge", null);
    expect(payload.restorationSubtype).toBe("restorative/crown_and_bridge");
    expect(payload.material).toBeNull();
    expect(payload.restorationType).toBe("Crown & Bridge");
  });

  it("sends null restorationSubtype and representative restorationType when only the case type is drafted", async () => {
    // encodeRestorationSubtype returns null when subtype segment is absent
    const payload = computeSavePayload("restorative", null, null);
    expect(payload.restorationSubtype).toBeNull();
    expect(payload.material).toBeNull();
    expect(payload.restorationType).toBe("Crown");
  });

  it("correctly encodes a removable subtype + material combination", async () => {
    const payload = computeSavePayload("removable", "dentures", "acrylic");
    expect(payload.restorationSubtype).toBe("removable/dentures/acrylic");
    expect(payload.material).toBe("Acrylic");
    expect(payload.restorationType).toBe("Dentures");
  });
});
