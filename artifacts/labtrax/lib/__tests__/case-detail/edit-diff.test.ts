import { describe, it, expect } from "vitest";
import {
  computeCaseEditDiff,
  buildInvoicePatchForCaseEdit,
} from "../../case-detail/edit-diff";

const baseCase = {
  doctorName: "Dr. Smith",
  patientName: "Jane Doe",
  patientInitials: "J.D.",
  toothIndices: "#8",
  shade: "A2",
  material: "Zirconia",
  dueDate: "",
  notes: "",
};

const sameForm = {
  doctor: "Dr. Smith",
  patient: "Jane Doe",
  teeth: "#8",
  shade: "A2",
  material: "Zirconia",
  dueDate: "",
  notes: "",
};

describe("computeCaseEditDiff", () => {
  it("returns no changes when nothing differs", () => {
    const diff = computeCaseEditDiff(baseCase, sameForm);
    expect(diff.changes).toEqual([]);
    expect(diff.updates).toEqual({});
    expect(diff.providerChanged).toBe(false);
  });

  it("captures provider change and a case-insensitive comparison", () => {
    const diff = computeCaseEditDiff(baseCase, { ...sameForm, doctor: "dr. smith" });
    // Same doctor with different casing: still emits an update because the
    // strings are not strictly equal, but providerChanged stays false so we
    // don't trigger an invoice transfer.
    expect(diff.updates.doctorName).toBe("dr. smith");
    expect(diff.providerChanged).toBe(false);

    const diff2 = computeCaseEditDiff(baseCase, { ...sameForm, doctor: "Dr. Jones" });
    expect(diff2.providerChanged).toBe(true);
    expect(diff2.changes[0]).toContain("Provider:");
  });

  it("recomputes patient initials when the patient name changes", () => {
    const diff = computeCaseEditDiff(baseCase, { ...sameForm, patient: "Mary Jane Watson" });
    expect(diff.updates.patientName).toBe("Mary Jane Watson");
    expect(diff.updates.patientInitials).toBe("MJ");
  });

  it("flags note edits without dumping the new content into the changelog", () => {
    const diff = computeCaseEditDiff(baseCase, { ...sameForm, notes: "Bigger margins" });
    expect(diff.changes).toEqual(["Notes updated"]);
    expect(diff.updates.notes).toBe("Bigger margins");
  });
});

describe("buildInvoicePatchForCaseEdit", () => {
  it("mirrors doctor / patient / tooth / shade fields onto the invoice patch", () => {
    const patch = buildInvoicePatchForCaseEdit({
      updates: {
        doctorName: "Dr. Jones",
        patientName: "Jane Doe",
        toothIndices: "#9",
        shade: "B2",
      },
      currentMaterial: "Zirconia",
    });
    expect(patch).toMatchObject({
      clientName: "Dr. Jones",
      billTo: "Dr. Jones",
      patientName: "Jane Doe",
      teeth: "#9",
      shade: "B2",
      caseType: "Zirconia Restoration",
    });
  });

  it("recomputes caseType when material or teeth change", () => {
    expect(
      buildInvoicePatchForCaseEdit({ updates: { material: "E.max" }, currentMaterial: "Zirconia" }).caseType,
    ).toBe("E.max Restoration");
    // No material/tooth change → no caseType update
    expect(
      buildInvoicePatchForCaseEdit({ updates: { shade: "A1" }, currentMaterial: "Zirconia" }).caseType,
    ).toBeUndefined();
  });

  it("translates dueDate into a unix-ms dueAt", () => {
    const patch = buildInvoicePatchForCaseEdit({
      updates: { dueDate: "2026-06-15" },
      currentMaterial: "Zirconia",
    });
    expect(patch.dueAt).toBe(new Date("2026-06-15T00:00:00").getTime());
  });
});
