import { pickProviderMatch } from "./provider-match";

export type ProviderEntry = {
  providerName: string;
  practiceName?: string;
  clientId: string;
};

export type AiDoctorAssignment =
  | { kind: "exact"; entry: ProviderEntry }
  | { kind: "similar"; entry: ProviderEntry }
  | { kind: "new" };

/**
 * Decides how the AI-extracted doctor name should be applied to the new
 * case form. Pure wrapper around `pickProviderMatch` so the scan screen
 * can stay UI-only and the decision is independently unit-testable.
 *
 *  - `exact`  → silently assign to the on-file provider spelling.
 *  - `similar` → prompt the user to confirm the match.
 *  - `new`    → prompt the user to add as a new provider.
 */
export function decideAiDoctorAssignment(
  data: { doctorName?: string; practiceName?: string },
  providerEntries: ProviderEntry[],
): AiDoctorAssignment {
  if (!data.doctorName) return { kind: "new" };

  const result = pickProviderMatch(
    providerEntries.map((e) => ({
      providerName: e.providerName,
      practiceName: e.practiceName ?? "",
      clientId: e.clientId,
    })),
    { name: data.doctorName, practiceName: data.practiceName },
  );

  if (result.kind === "exact") {
    return { kind: "exact", entry: result.entry as ProviderEntry };
  }
  if (result.kind === "similar") {
    return { kind: "similar", entry: result.entry as ProviderEntry };
  }
  return { kind: "new" };
}
