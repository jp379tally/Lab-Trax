/**
 * How one row of a provider's case list reads.
 *
 * The provider case list exists on both platforms — the desktop dashboard
 * (`artifacts/labtrax-desktop/src/components/provider/ProviderDashboard.tsx`)
 * and its mobile mirror
 * (`artifacts/labtrax/components/provider-portal/sections/ProviderDashboardSection.tsx`).
 * Desktop lays the rows out as a table and mobile as stacked cards, but a
 * provider looking at the same case on a phone and on a desktop must read the
 * same status, the same due date, the same patient, and the same open balance.
 * These rules therefore live here, once, instead of as a copy per platform
 * that agrees only until somebody edits one side alone.
 *
 * Two of the rules below deliberately disagree with the general-purpose
 * formatters each app ships (`artifacts/labtrax/lib/format.ts` and
 * `artifacts/labtrax-desktop/src/lib/format.ts`), so neither platform may
 * "clean this up" by routing these values through its own module:
 *
 *   - a zero open balance reads as an em dash, where mobile's `formatMoney`
 *     renders "$0.00";
 *   - a status is split on underscores and whitespace only — never on hyphens
 *     — where mobile's `titleCase` would turn "in-house" into "In House".
 *
 * Both exceptions are covered by
 * `artifacts/labtrax-desktop/src/lib/__tests__/provider-case-format.test.ts`
 * (the rules themselves) and by the rows rendered in
 * `artifacts/labtrax/app/__tests__/provider-dashboard-section.test.tsx`, so a
 * later swap back to a platform formatter fails both platforms' test gates.
 */

/** What a provider case row shows in place of a value it does not have. */
export const PROVIDER_CASE_EMPTY_VALUE = "—";

/**
 * A case status as a provider reads it: "in_progress" → "In Progress".
 *
 * Words are separated by underscores and whitespace only. A hyphen is part of
 * the word, so a hyphenated status keeps its hyphen and is never split into
 * two words.
 */
export function providerStatusLabel(status: string): string {
  return status
    .split(/[_\s]+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/**
 * An open balance on a provider case row. Nothing owed — a zero balance, or a
 * case carrying no invoice at all — reads as an em dash rather than "$0.00",
 * so the rows that need the provider's attention are the only ones showing an
 * amount.
 */
export function formatProviderBalance(amount: number | null | undefined): string {
  if (amount == null || amount === 0) return PROVIDER_CASE_EMPTY_VALUE;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

/** The patient fields a provider case row reads, on either platform. */
export interface ProviderPatientName {
  patientFirstName?: string | null;
  patientLastName?: string | null;
  patientInitials?: string | null;
}

/**
 * The patient as named on the case: their full name when the lab holds one,
 * otherwise the initials a privacy-restricted practice sends instead.
 */
export function providerPatientDisplayName(patient: ProviderPatientName): string {
  if (patient.patientFirstName || patient.patientLastName) {
    return `${patient.patientFirstName ?? ""} ${patient.patientLastName ?? ""}`.trim();
  }
  return patient.patientInitials ?? PROVIDER_CASE_EMPTY_VALUE;
}

/**
 * A due date as "MM/DD/YYYY".
 *
 * Due dates carry no time of day: the picked day is stored as a UTC-midnight
 * timestamp, so the day is read back from UTC components. Reading local ones
 * shifts the date a day earlier for every viewer behind UTC — most of the
 * Americas — while looking correct in a UTC test environment.
 */
export function formatProviderDueDate(value: string | null | undefined): string {
  if (!value) return PROVIDER_CASE_EMPTY_VALUE;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const d = m
    ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    : new Date(value);
  if (Number.isNaN(d.getTime())) return PROVIDER_CASE_EMPTY_VALUE;
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}
