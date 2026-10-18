import { describe, expect, it } from "vitest";
import {
  doctorDisplayNameForRow,
  doctorIdentityForRow,
  normalizeDoctorIdentity,
  retainVisibleSelection,
  visibleDoctorScopedRows,
} from "../doctor-payment-scope";

describe("doctor payment scope", () => {
  it("normalizes canonical identities while retaining immutable display names", () => {
    const row = {
      id: "payment-1",
      doctorIdentity: "  DR-ADA  ",
      doctorDisplayName: "Dr. Ada (North)",
      paymentSession: { doctorIdentity: "wrong", doctorDisplayName: "Old name" },
    };
    expect(normalizeDoctorIdentity("  Dr   Ada  ")).toBe("dr ada");
    expect(doctorIdentityForRow(row)).toBe("dr-ada");
    expect(doctorDisplayNameForRow(row)).toBe("Dr. Ada (North)");
    expect(visibleDoctorScopedRows([row], "all", " DR-ADA ")).toEqual([row]);
  });

  it("keeps entire-practice rows separate and clears hidden selections", () => {
    const rows = [
      { id: "ada", providerOrganizationId: "p1", paymentSession: { doctorIdentity: "dr-ada", doctorDisplayName: "Dr. Ada" } },
      { id: "practice", providerOrganizationId: "p1", paymentSession: null },
    ];
    expect(visibleDoctorScopedRows(rows, "p1", "entire").map(({ id }) => id)).toEqual(["practice"]);
    expect([...retainVisibleSelection(new Set(["ada", "practice"]), ["ada"])]).toEqual(["ada"]);
  });

  it("separates renamed or duplicate display names by stable identity", () => {
    const rows = [
      {
        id: "renamed",
        providerOrganizationId: "p1",
        doctorIdentity: "doctor-profile-1",
        doctorDisplayName: "Dr. Renamed",
      },
      {
        id: "duplicate",
        providerOrganizationId: "p1",
        doctorIdentity: "doctor-profile-2",
        doctorDisplayName: "Dr. Renamed",
      },
      {
        id: "legacy",
        providerOrganizationId: "p1",
        doctorName: "Dr. Renamed",
      },
    ];

    expect(visibleDoctorScopedRows(rows, "p1", "doctor-profile-1").map(({ id }) => id))
      .toEqual(["renamed"]);
    expect(visibleDoctorScopedRows(rows, "p1", "doctor-profile-2").map(({ id }) => id))
      .toEqual(["duplicate"]);
    expect(visibleDoctorScopedRows(rows, "p1", "Dr. Renamed").map(({ id }) => id))
      .toEqual(["legacy"]);
  });

  it("keeps null-attributed rows in the entire-practice scope", () => {
    const rows = [
      { id: "unattributed", providerOrganizationId: "p1", doctorName: null },
      { id: "identified", providerOrganizationId: "p1", doctorIdentity: "doctor-profile-1" },
    ];

    expect(visibleDoctorScopedRows(rows, "p1", "entire").map(({ id }) => id))
      .toEqual(["unattributed"]);
  });
});