/**
 * Provider-owned clinical preferences are structured case data, not the
 * lab-authored free-text note stored on a doctor profile. Keep their display
 * order stable so every desktop print path says the same thing.
 */
export interface ProviderPreferences {
  occlusionAmount?: number | null;
  occlusionUnit?: "mm" | "microns" | null;
  proximalContactAmount?: number | null;
  proximalContactUnit?: "mm" | "microns" | null;
  anatomyPreference?:
    | "primary_only"
    | "primary_and_secondary"
    | "other"
    | null;
  anatomyOther?: string | null;
  caseQuestionContactMethod?: "text" | "phone_call" | "email" | null;
  caseQuestionContactValue?: string | null;
}

function formatMeasurement(amount: unknown, unit: unknown): string {
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    (unit !== "mm" && unit !== "microns")
  ) {
    return "";
  }
  return `${amount} ${unit}`;
}

/**
 * Formats only supported, non-blank structured values in a fixed clinical
 * order. An empty string means there is nothing meaningful to print.
 */
export function formatProviderPreferences(
  preferences: ProviderPreferences | null | undefined,
): string {
  if (!preferences || typeof preferences !== "object") return "";

  const occlusion = formatMeasurement(
    preferences.occlusionAmount,
    preferences.occlusionUnit,
  );
  const proximalContact = formatMeasurement(
    preferences.proximalContactAmount,
    preferences.proximalContactUnit,
  );
  const anatomy =
    preferences.anatomyPreference === "primary_only"
      ? "Primary only"
      : preferences.anatomyPreference === "primary_and_secondary"
        ? "Primary and secondary"
        : preferences.anatomyPreference === "other" &&
            typeof preferences.anatomyOther === "string" &&
            preferences.anatomyOther.trim()
          ? preferences.anatomyOther.trim()
          : "";
  const method =
    preferences.caseQuestionContactMethod === "phone_call"
      ? "Phone call"
      : preferences.caseQuestionContactMethod === "text"
        ? "Text"
        : preferences.caseQuestionContactMethod === "email"
          ? "Email"
          : "";
  const contactValue =
    typeof preferences.caseQuestionContactValue === "string"
      ? preferences.caseQuestionContactValue.trim()
      : "";
  const questionContact = method && contactValue
    ? `${method}: ${contactValue}`
    : "";

  return [
    occlusion && `Occlusion: ${occlusion}`,
    proximalContact && `Proximal contact: ${proximalContact}`,
    anatomy && `Anatomy: ${anatomy}`,
    questionContact && `Case questions: ${questionContact}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

export function providerDoctorPreferencesForLabSlip(
  labCase: {
    providerDoctorPreferences?: ProviderPreferences | null;
    printProviderPreferencesOnLabSlips?: boolean | null;
  },
): string {
  return labCase.printProviderPreferencesOnLabSlips === true
    ? formatProviderPreferences(labCase.providerDoctorPreferences)
    : "";
}