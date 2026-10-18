import type {
  CaseRestorationHierarchyUpdateInput,
  CaseRestorationHierarchyUpdateResultData,
} from "@workspace/api-client-react";
import { resilientFetch, throwIfResNotOk } from "./query-client";
import { deriveCaseHierarchy, sameClinicalHierarchy } from "@workspace/case-taxonomy";
import { isArchRequired } from "./arch";

export interface ClinicalSource {
  step?: string | null;
  stepShade?: string | null;
  restorations?: Array<{
    restorationType?: string | null;
    restorationSubtype?: string | null;
    material?: string | null;
    arch?: string | null;
    shade?: string | null;
    toothNumber?: string | null;
  }> | null;
}

export interface ClinicalDraft {
  restorationType: string;
  restorationSubtype: string | null;
  material: string;
  arch: "" | "upper" | "lower" | "both";
  shade: string;
  teeth: string;
  step: string;
  stepShade: string;
}

export function clinicalDraftFromCase(source: ClinicalSource): ClinicalDraft {
  const rows = (source.restorations ?? []).filter((r) => r.restorationType !== "missing");
  const arches = new Set(rows.map((r) => r.arch).filter(Boolean));
  const join = (values: Array<string | null | undefined>) =>
    [...new Set(values.filter((value): value is string => !!value))].join(", ");
  return {
    restorationType: rows[0]?.restorationType || "Other",
    restorationSubtype: rows[0]?.restorationSubtype ?? null,
    material: join(rows.map((r) => r.material)),
    arch: arches.has("upper_lower") || arches.size > 1 ? "both" : arches.has("upper") ? "upper" : arches.has("lower") ? "lower" : "",
    shade: join(rows.map((r) => r.shade)),
    teeth: join(rows.map((r) => r.toothNumber)),
    step: source.step ?? "",
    stepShade: source.stepShade ?? "",
  };
}

/** Omit unchanged shades and arches so per-row values survive the whole-set edit. */
export function buildClinicalPayload(
  source: ClinicalSource,
  draft: ClinicalDraft,
  canEditStep: boolean,
): CaseRestorationHierarchyUpdateInput | null {
  const original = clinicalDraftFromCase(source);
  const changed = Object.keys(original).some((key) => {
    if (key === "restorationType" || key === "restorationSubtype" || key === "material") return !sameClinicalHierarchy(original, draft);
    if (!canEditStep && (key === "step" || key === "stepShade")) return false;
    return original[key as keyof ClinicalDraft] !== draft[key as keyof ClinicalDraft];
  });
  if (!changed) return null;
  const needsArch = isArchRequired(deriveCaseHierarchy(
    draft.restorationType, draft.restorationSubtype, draft.material,
  ).caseType);
  const missingArch = (source.restorations ?? [])
    .filter((row) => row.restorationType !== "missing")
    .some((row) => !row.arch);
  return {
    restorationType: draft.restorationType,
    restorationSubtype: draft.restorationSubtype,
    material: draft.material.trim() || null,
    toothNumbers: [...new Set(draft.teeth.split(/[\s,;]+/).filter(Boolean))],
    ...(draft.shade !== original.shade ? { shade: draft.shade.trim() || null } : {}),
    ...(draft.arch && (draft.arch !== original.arch || (needsArch && missingArch))
      ? { arch: draft.arch === "both" ? "upper_lower" : draft.arch }
      : {}),
    ...(canEditStep && draft.step !== original.step
      ? { step: (draft.step || null) as CaseRestorationHierarchyUpdateInput["step"] }
      : {}),
    ...(canEditStep && (draft.stepShade !== original.stepShade || draft.step !== original.step)
      ? { stepShade: draft.step === "wax_setup" ? draft.stepShade.trim() || null : null }
      : {}),
  };
}

export async function saveClinicalDetails(
  caseId: string,
  payload: CaseRestorationHierarchyUpdateInput,
): Promise<CaseRestorationHierarchyUpdateResultData> {
  const response = await resilientFetch(`/api/cases/${caseId}/restorations/hierarchy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await throwIfResNotOk(response);
  const result = await response.json();
  if (!result.data || !result.data.invoiceAction) {
    throw new Error("Clinical details were saved, but the invoice outcome was missing. Refresh the case before saving again.");
  }
  return result.data;
}

export function clinicalSaveMessage(result: CaseRestorationHierarchyUpdateResultData): string {
  const invoice = {
    updated: "Invoice updated.",
    created: "Invoice created.",
    skipped: "Invoice left unchanged.",
    needs_review: "The reviewed invoice was flagged for review and left unchanged.",
  }[result.invoiceAction];
  return [
    "Clinical details saved.",
    result.repricedCount ? `${result.repricedCount} rows repriced.` : "",
    result.manualPriceCount ? `${result.manualPriceCount} manual prices kept.` : "",
    result.unpricedCount ? `${result.unpricedCount} rows left unpriced.` : "",
    invoice,
  ].filter(Boolean).join(" ");
}
