// Shared case-label print action.
//
// Both the barcode-assignment prompt on the case screen and the returned-case
// wizard print the same work-order label: the lab's org print template (when
// one exists) merged into the canonical buildCaseCardHtml renderer, handed to
// the system print dialog.
import * as Print from "expo-print";
import {
  shouldIncludeProviderPreferencesOnLabSlip,
  type CaseCardRestoration,
} from "@/lib/case-pdf";
import { resilientFetch } from "@/lib/query-client";
import { buildSharedCaseSlipHtml } from "@/lib/shared-case-slip";

interface OrgPrintTemplate {
  template?: unknown;
  isCustom?: boolean | null;
}

export interface PrintableLabelCase {
  /** Required so the print action can load the current authorized case. */
  id: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  dueDate?: string | null;
  status?: string | null;
  caseNotes?: string | null;
  casePanBarcode?: string | null;
  gingivialShade?: string | null;
  providerDoctorPreferences?: Record<string, unknown> | null;
  printProviderPreferencesOnLabSlips?: boolean | null;
  labOrganizationId?: string | null;
  organizationId?: string | null;
  priority?: string | null;
  step?: string | null;
  stepShade?: string | null;
  dueTime?: string | null;
  doctorPreferences?: string | null;
  providerOrganizationContact?: Record<string, unknown> | null;
  restorations?:
    | Array<CaseCardRestoration & {
        toothNumber?: string | null;
        restorationType?: string | null;
        material?: string | null;
        shade?: string | null;
      }>
    | null;
}

export interface PrintCaseLabelOptions {
  /** Falls back to the lab name baked into the org print template. */
  labName?: string | null;
  /** Overrides the case's own barcode (e.g. one just assigned but not refetched). */
  barcode?: string | null;
}

/**
 * Renders the case work-order label and opens the system print dialog.
 * Throws on print failure so callers can surface their own alert.
 */
export async function printCaseLabel(
  c: PrintableLabelCase,
  opts: PrintCaseLabelOptions = {},
): Promise<void> {
  // Callers commonly arrive here from a returned-case wizard or just after a
  // barcode mutation. Always print the server's current case fields instead
  // of that cached screen state. The one intentional exception is opts.barcode:
  // it represents the barcode just assigned in the current interaction.
  const caseRes = await resilientFetch(`/api/cases/${encodeURIComponent(c.id)}`);
  if (!caseRes.ok) {
    throw new Error(`Could not load the latest case details (${caseRes.status}).`);
  }
  const caseBody = (await caseRes.json()) as { data?: PrintableLabelCase } & PrintableLabelCase;
  const currentCase = caseBody.data ?? caseBody;
  if (!currentCase || typeof currentCase !== "object") {
    throw new Error("Could not load the latest case details.");
  }

  let orgTemplate: OrgPrintTemplate | null = null;
  const labOrgId = currentCase.labOrganizationId ?? currentCase.organizationId ?? null;
  if (labOrgId) {
    try {
      const tmplRes = await resilientFetch(
        `/api/organizations/${encodeURIComponent(labOrgId)}/case-print-template?caseId=${encodeURIComponent(c.id)}`,
      );
      if (!tmplRes.ok) throw new Error(`Could not load the shared lab-slip template (${tmplRes.status}).`);
      if (tmplRes.ok) {
        const body = (await tmplRes.json()) as { data?: OrgPrintTemplate };
        orgTemplate = body?.data ?? null;
      }
    } catch (error) {
      throw new Error("Could not load the shared lab-slip template. Check your connection and try again.", { cause: error });
    }
  }

  const templateLabName = orgTemplate?.template
    ? ((orgTemplate.template as Record<string, unknown>)?.labName as string | undefined)
    : undefined;

  const html = await buildSharedCaseSlipHtml({
    caseNumber: currentCase.caseNumber ?? undefined,
    patientName:
      [currentCase.patientFirstName, currentCase.patientLastName].filter(Boolean).join(" ") || undefined,
    doctorName: currentCase.doctorName ?? undefined,
    dueDate: currentCase.dueDate ?? undefined,
    priority: currentCase.priority ?? undefined,
    status: (currentCase.status ?? "received") as string,
    rxNotes: currentCase.caseNotes ?? undefined,
    restorations: (currentCase.restorations ?? []).map(
      (r): CaseCardRestoration => ({ ...r }),
    ),
    labName: templateLabName ?? opts.labName ?? undefined,
    casePanBarcode: opts.barcode ?? currentCase.casePanBarcode ?? undefined,
    gingivialShade: currentCase.gingivialShade ?? null,
    providerDoctorPreferences: currentCase.providerDoctorPreferences ?? null,
    printProviderPreferencesOnLabSlips: shouldIncludeProviderPreferencesOnLabSlip(
      currentCase.printProviderPreferencesOnLabSlips,
      orgTemplate,
    ),
  }, orgTemplate, { caseId: currentCase.id ?? c.id, labOrganizationId: labOrgId, step: currentCase.step, stepShade: currentCase.stepShade, dueTime: currentCase.dueTime, doctorPreferences: currentCase.doctorPreferences, providerOrganizationContact: currentCase.providerOrganizationContact });

  await Print.printAsync({ html });
}
