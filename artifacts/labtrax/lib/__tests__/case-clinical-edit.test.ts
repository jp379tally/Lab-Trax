import { describe, expect, it } from "vitest";
import {
  buildClinicalPayload, clinicalDraftFromCase, clinicalSaveMessage, saveClinicalDetails,
} from "../case-clinical-edit";
import { setMockFetchHandler, resetMockFetchHandler } from "../../vitest.setup";

describe("Lab Slip clinical edit contract", () => {
  it("does not send clinical reconciliation for a metadata-only Implant dropdown label round trip", () => {
    const implant = { restorations: [{ restorationType: "Crown", restorationSubtype: "restorative/implant/zirconia", material: "Zirconia", toothNumber: "14" }] };
    expect(buildClinicalPayload(implant, { ...clinicalDraftFromCase(implant), restorationType: "Implant" }, true)).toBeNull();
  });
  const source = {
    step: "wax_setup", stepShade: "A2",
    restorations: [
      { restorationType: "Crown", material: "Zirconia", arch: "upper", shade: "A1", toothNumber: "8" },
      { restorationType: "Crown", material: "Zirconia", arch: "lower", shade: "B1", toothNumber: "9" },
    ],
  };

  it("omits untouched arches and per-tooth shades when switching type", () => {
    const draft = { ...clinicalDraftFromCase(source), restorationType: "Full Denture", material: "Acrylic" };
    const input = buildClinicalPayload(source, draft, true)!;
    expect(input).toMatchObject({ restorationType: "Full Denture", material: "Acrylic", toothNumbers: ["8", "9"] });
    expect(input).not.toHaveProperty("arch");
    expect(input).not.toHaveProperty("shade");
    expect(input).not.toHaveProperty("quantity");
    expect(input).not.toHaveProperty("unitPrice");
  });

  it("creates an arch-level line for a restoration-free case", () => {
    const blank = { restorations: null };
    const draft = { ...clinicalDraftFromCase(blank), restorationType: "Full Denture", arch: "both" as const, material: "Acrylic" };
    expect(buildClinicalPayload(blank, draft, true)).toMatchObject({
      restorationType: "Full Denture", arch: "upper_lower", toothNumbers: [],
    });
  });

  it("fills missing row arches when moving to a required-arch case type", () => {
    const incomplete = { restorations: [
      { restorationType: "Crown", toothNumber: "8", arch: "upper" },
      { restorationType: "Crown", toothNumber: "9", arch: null },
    ] };
    expect(buildClinicalPayload(incomplete, {
      ...clinicalDraftFromCase(incomplete), restorationType: "Full Denture",
    }, true)).toMatchObject({ arch: "upper" });
  });

  it("does not send clinical writes when nothing changed", () => {
    expect(buildClinicalPayload(source, clinicalDraftFromCase(source), true)).toBeNull();
  });

  it("clears wax shade when leaving wax setup and respects the step permission", () => {
    const draft = { ...clinicalDraftFromCase(source), step: "finish" };
    expect(buildClinicalPayload(source, draft, true)).toMatchObject({ step: "finish", stepShade: null });
    expect(buildClinicalPayload(source, draft, false)).toBeNull();
  });

  it("reports all invoice outcomes and quote counts", () => {
    for (const [invoiceAction, message] of Object.entries({
      updated: "Invoice updated.", created: "Invoice created.", skipped: "Invoice left unchanged.",
      needs_review: "flagged for review and left unchanged.",
    })) {
      expect(clinicalSaveMessage({
        invoiceAction: invoiceAction as "updated", repricedCount: 2, manualPriceCount: 1, unpricedCount: 1,
        updatedCount: 2, createdCount: 0, deletedCount: 0,
      })).toContain(message);
    }
  });

  it("uses one whole-case request and returns the actual invoice result", async () => {
    const input = buildClinicalPayload(source, { ...clinicalDraftFromCase(source), material: "Acrylic" }, true)!;
    const requests: Array<{ url: string; body: unknown }> = [];
    setMockFetchHandler((url, init) => {
      requests.push({ url, body: JSON.parse(init?.body as string) });
      return new Response(JSON.stringify({ data: { invoiceAction: "created", repricedCount: 2 } }));
    });
    try {
      expect(await saveClinicalDetails("case-1", input)).toMatchObject({ invoiceAction: "created" });
      expect(requests).toEqual([{ url: "/api/cases/case-1/restorations/hierarchy", body: input }]);
    } finally { resetMockFetchHandler(); }
  });

  it("surfaces a refused write instead of reporting invoice success", async () => {
    setMockFetchHandler(() => new Response(JSON.stringify({ message: "Choose an arch." }), { status: 400 }));
    try {
      await expect(saveClinicalDetails("case-1", {
        restorationType: "Full Denture", restorationSubtype: null, material: null,
      })).rejects.toThrow("Choose an arch.");
    } finally { resetMockFetchHandler(); }
  });
});
