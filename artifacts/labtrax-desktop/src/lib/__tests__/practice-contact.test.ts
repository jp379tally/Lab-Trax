import { describe, expect, it } from "vitest";
import {
  formatPracticeAddressLines,
  resolvePracticeContact,
} from "@/lib/practice-contact";

describe("formatPracticeAddressLines", () => {
  it("builds street and city/state/zip lines", () => {
    expect(
      formatPracticeAddressLines({
        addressLine1: "120 Main St",
        addressLine2: "Suite 4",
        city: "Austin",
        state: "TX",
        zip: "78701",
      }),
    ).toEqual(["120 Main St", "Suite 4", "Austin, TX 78701"]);
  });

  it("skips missing parts instead of printing empty punctuation", () => {
    expect(
      formatPracticeAddressLines({ city: "Austin", state: null, zip: "78701" }),
    ).toEqual(["Austin 78701"]);
    expect(formatPracticeAddressLines({ addressLine1: "120 Main St" })).toEqual([
      "120 Main St",
    ]);
    expect(formatPracticeAddressLines({ state: "TX" })).toEqual(["TX"]);
  });

  it("returns no lines at all when nothing is on file", () => {
    expect(formatPracticeAddressLines(null)).toEqual([]);
    expect(
      formatPracticeAddressLines({ addressLine1: "  ", city: "", zip: null }),
    ).toEqual([]);
  });
});

describe("resolvePracticeContact", () => {
  const caseContact = {
    name: "Bright Dental",
    addressLine1: "120 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    phone: "5125550143",
  };
  const otherPractice = {
    id: "prov-2",
    displayName: "Other Practice",
    addressLine1: "999 Wrong Way",
    city: "Nowhere",
    state: "ZZ",
    zip: "00000",
    phone: "5559999999",
  };

  it("uses the case-scoped contact for the practice the case is linked to", () => {
    expect(
      resolvePracticeContact({
        selectedPracticeId: "prov-1",
        casePracticeId: "prov-1",
        caseContact,
        listOrganization: { id: "prov-1", displayName: "Bright Dental" },
      }),
    ).toEqual({
      name: "Bright Dental",
      addressLines: ["120 Main St", "Austin, TX 78701"],
      phone: "5125550143",
    });
  });

  it("still names a practice the viewer cannot list", () => {
    expect(
      resolvePracticeContact({
        selectedPracticeId: "prov-1",
        casePracticeId: "prov-1",
        caseContact,
        listOrganization: null,
      }),
    ).toEqual({
      name: "Bright Dental",
      addressLines: ["120 Main St", "Austin, TX 78701"],
      phone: "5125550143",
    });
  });

  it("drops the case contact once a different practice is staged", () => {
    expect(
      resolvePracticeContact({
        selectedPracticeId: "prov-2",
        casePracticeId: "prov-1",
        caseContact,
        listOrganization: otherPractice,
      }),
    ).toEqual({
      name: "Other Practice",
      addressLines: ["999 Wrong Way", "Nowhere, ZZ 00000"],
      phone: "5559999999",
    });
  });

  it("reports no contact rather than a stale one when nothing describes the selection", () => {
    expect(
      resolvePracticeContact({
        selectedPracticeId: "prov-3",
        casePracticeId: "prov-1",
        caseContact,
        listOrganization: null,
      }),
    ).toEqual({ name: null, addressLines: [], phone: null });
  });

  it("never borrows another practice's details for the selected one", () => {
    const resolved = resolvePracticeContact({
      selectedPracticeId: "prov-1",
      casePracticeId: "prov-1",
      caseContact: { name: "Bright Dental" },
      listOrganization: otherPractice,
    });
    expect(resolved.addressLines).toEqual([]);
    expect(resolved.phone).toBeNull();
    expect(resolved.name).toBe("Bright Dental");
  });

  it("reports nothing when the case has no practice at all", () => {
    expect(
      resolvePracticeContact({
        selectedPracticeId: null,
        casePracticeId: null,
        caseContact: null,
        listOrganization: null,
      }),
    ).toEqual({ name: null, addressLines: [], phone: null });
  });
});
