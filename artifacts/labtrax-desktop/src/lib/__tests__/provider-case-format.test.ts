// The rules a provider case row is formatted by, shared between the desktop
// ProviderDashboard and its mobile mirror (ProviderDashboardSection) through
// @workspace/provider-case-format.
//
// Both platforms read these values out of the same module, so this file is the
// one place the rules themselves are pinned. Two of them deliberately disagree
// with the general-purpose formatters each app ships — a zero balance is an em
// dash rather than "$0.00", and a hyphenated status keeps its hyphen instead
// of becoming two words — and those two are the ones a later "cleanup" onto
// `@/lib/format` (desktop) or `lib/format.ts` (mobile) would silently undo, so
// they are asserted against the output those formatters would have produced.
import { describe, expect, it } from "vitest";
import {
  PROVIDER_CASE_EMPTY_VALUE,
  formatProviderBalance,
  formatProviderDueDate,
  providerPatientDisplayName,
  providerStatusLabel,
} from "@workspace/provider-case-format";
import {
  formatInvoiceLineMoney,
  formatMoney,
  formatShortDueDate,
} from "../format";

describe("providerStatusLabel", () => {
  it("capitalizes each underscore-separated word", () => {
    expect(providerStatusLabel("in_progress")).toBe("In Progress");
    expect(providerStatusLabel("sintering_furnace")).toBe("Sintering Furnace");
    expect(providerStatusLabel("complete")).toBe("Complete");
  });

  it("treats whitespace as a word separator and collapses runs of it", () => {
    expect(providerStatusLabel("on  hold")).toBe("On Hold");
    expect(providerStatusLabel("post_mill room")).toBe("Post Mill Room");
  });

  it("keeps a hyphenated status as one word", () => {
    // The mobile titleCase() helper splits on [_-]+ and would render these as
    // "In House" / "Re Do"; the provider list must not gain that space.
    expect(providerStatusLabel("in-house")).toBe("In-house");
    expect(providerStatusLabel("re-do_pending")).toBe("Re-do Pending");
    expect(providerStatusLabel("in-house")).not.toContain(" ");
  });

  it("returns an empty label for an empty status rather than throwing", () => {
    expect(providerStatusLabel("")).toBe("");
  });
});

describe("formatProviderBalance", () => {
  it("shows an em dash when nothing is owed", () => {
    // `@/lib/format`'s formatMoney renders both of these as "$0.00" — the
    // provider list deliberately shows an amount only on rows that owe one.
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-12.34)).toBe("-$12.34");
    expect(formatInvoiceLineMoney(-12.34)).toBe("−$12.34");
    expect(formatProviderBalance(0)).toBe(PROVIDER_CASE_EMPTY_VALUE);
    expect(formatProviderBalance(null)).toBe(PROVIDER_CASE_EMPTY_VALUE);
    expect(formatProviderBalance(undefined)).toBe(PROVIDER_CASE_EMPTY_VALUE);
  });

  it("formats an outstanding balance as US currency with both cents", () => {
    expect(formatProviderBalance(1234.5)).toBe("$1,234.50");
    expect(formatProviderBalance(0.5)).toBe("$0.50");
    expect(formatProviderBalance(-40)).toBe("-$40.00");
  });
});

describe("providerPatientDisplayName", () => {
  it("uses the patient's full name when the lab holds one", () => {
    expect(
      providerPatientDisplayName({
        patientFirstName: "Jane",
        patientLastName: "Doe",
        patientInitials: "J.D.",
      }),
    ).toBe("Jane Doe");
  });

  it("trims a half-known name instead of leaving a stray space", () => {
    expect(
      providerPatientDisplayName({ patientFirstName: "Jane", patientLastName: null }),
    ).toBe("Jane");
    expect(
      providerPatientDisplayName({ patientFirstName: "", patientLastName: "Doe" }),
    ).toBe("Doe");
  });

  it("falls back to the initials a privacy-restricted practice sends", () => {
    expect(
      providerPatientDisplayName({
        patientFirstName: null,
        patientLastName: null,
        patientInitials: "J.D.",
      }),
    ).toBe("J.D.");
  });

  it("shows an em dash when the case names no patient at all", () => {
    expect(providerPatientDisplayName({})).toBe(PROVIDER_CASE_EMPTY_VALUE);
    expect(
      providerPatientDisplayName({
        patientFirstName: null,
        patientLastName: null,
        patientInitials: null,
      }),
    ).toBe(PROVIDER_CASE_EMPTY_VALUE);
  });
});

describe("formatProviderDueDate", () => {
  it("renders the calendar day the provider picked, not the viewer's local day", () => {
    // A UTC-midnight timestamp read with local getters shows 09/09 anywhere
    // behind UTC; the row must show the day that was picked.
    expect(formatProviderDueDate("2026-09-10T00:00:00.000Z")).toBe("09/10/2026");
    expect(formatProviderDueDate("2026-09-10")).toBe("09/10/2026");
  });

  it("matches what the rest of desktop shows for the same due date", () => {
    for (const due of ["2026-01-05T00:00:00.000Z", "2026-12-31", "2026-06-25T00:00:00.000Z"]) {
      expect(formatProviderDueDate(due)).toBe(formatShortDueDate(due));
    }
  });

  it("shows an em dash for a missing or unreadable due date", () => {
    expect(formatProviderDueDate(null)).toBe(PROVIDER_CASE_EMPTY_VALUE);
    expect(formatProviderDueDate(undefined)).toBe(PROVIDER_CASE_EMPTY_VALUE);
    expect(formatProviderDueDate("")).toBe(PROVIDER_CASE_EMPTY_VALUE);
    expect(formatProviderDueDate("not a date")).toBe(PROVIDER_CASE_EMPTY_VALUE);
  });
});
