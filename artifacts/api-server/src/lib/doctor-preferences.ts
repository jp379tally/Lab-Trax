export type DoctorPreferences = {
  occlusionAmount: number | null;
  occlusionUnit: "mm" | "microns" | null;
  proximalContactAmount: number | null;
  proximalContactUnit: "mm" | "microns" | null;
  anatomyPreference: "primary_only" | "primary_and_secondary" | "other" | null;
  anatomyOther: string | null;
  caseQuestionContactMethod: "text" | "phone_call" | "email" | null;
  caseQuestionContactValue: string | null;
};

/**
 * Provides the stable, fully-shaped representation of the nullable JSON
 * stored on provider users. Invalid legacy values are treated as unset.
 */
export function formatDoctorPreferences(raw: unknown): DoctorPreferences {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    occlusionAmount:
      typeof value.occlusionAmount === "number" &&
      Number.isFinite(value.occlusionAmount) &&
      value.occlusionAmount >= 0
        ? value.occlusionAmount
        : null,
    occlusionUnit:
      value.occlusionUnit === "mm" || value.occlusionUnit === "microns"
        ? value.occlusionUnit
        : null,
    proximalContactAmount:
      typeof value.proximalContactAmount === "number" &&
      Number.isFinite(value.proximalContactAmount) &&
      value.proximalContactAmount >= 0
        ? value.proximalContactAmount
        : null,
    proximalContactUnit:
      value.proximalContactUnit === "mm" ||
      value.proximalContactUnit === "microns"
        ? value.proximalContactUnit
        : null,
    anatomyPreference:
      value.anatomyPreference === "primary_only" ||
      value.anatomyPreference === "primary_and_secondary" ||
      value.anatomyPreference === "other"
        ? value.anatomyPreference
        : null,
    anatomyOther:
      typeof value.anatomyOther === "string" &&
      value.anatomyOther.trim().length > 0
        ? value.anatomyOther.trim().slice(0, 100)
        : null,
    caseQuestionContactMethod:
      value.caseQuestionContactMethod === "text" ||
      value.caseQuestionContactMethod === "phone_call" ||
      value.caseQuestionContactMethod === "email"
        ? value.caseQuestionContactMethod
        : null,
    caseQuestionContactValue:
      typeof value.caseQuestionContactValue === "string" &&
      value.caseQuestionContactValue.trim().length > 0
        ? value.caseQuestionContactValue.trim()
        : null,
  };
}