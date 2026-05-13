import { describe, expect, it } from "vitest";
import {
  computeQuickEditPlan,
  type QuickEditCaseSnapshot,
  type QuickEditFormValues,
} from "../../case-detail/quick-edit";

const baseCase: QuickEditCaseSnapshot = {
  doctorName: "Dr. Smith",
  patientName: "Jane Doe",
  toothIndices: "30,31",
  shade: "A2",
  material: "Zirconia",
  dueDate: "2026-04-15",
  notes: "old note",
  caseType: "Crown",
  isRush: false,
  invoiceId: "inv-1",
};

const baseForm = (overrides: Partial<QuickEditFormValues> = {}): QuickEditFormValues => ({
  doctor: "Dr. Smith",
  patient: "Jane Doe",
  teeth: "30,31",
  shade: "A2",
  material: "Zirconia",
  dueDate: "2026-04-15",
  notes: "old note",
  ...overrides,
});

describe("computeQuickEditPlan", () => {
  it("returns no changes when form matches case", () => {
    const plan = computeQuickEditPlan(baseCase, baseForm(), () => 100);
    expect(plan.changes).toEqual([]);
    expect(plan.caseUpdates).toEqual({});
    expect(plan.invoicePatch).toBeUndefined();
  });

  it("captures field-only changes via fields patch", () => {
    const plan = computeQuickEditPlan(baseCase, baseForm({ shade: "B1" }), () => 100);
    expect(plan.changes).toEqual(["Shade: B1"]);
    expect(plan.caseUpdates).toEqual({ shade: "B1" });
    expect(plan.invoicePatch).toEqual({ shade: "B1" });
    expect(plan.newPrice).toBeUndefined();
  });

  it("rebuilds invoice when material/teeth/doctor change", () => {
    const plan = computeQuickEditPlan(
      baseCase,
      baseForm({ material: "PFM", teeth: "30,31,32" }),
      () => 200,
    );
    expect(plan.caseUpdates).toEqual({ material: "PFM", toothIndices: "30,31,32" });
    expect(plan.newPrice).toBe(600);
    expect(plan.invoicePatch?.lineItems).toHaveLength(1);
    expect(plan.invoicePatch?.lineItems?.[0]).toMatchObject({ qty: 3, rate: 200, amount: 600 });
  });

  it("adds rush fee line item on rebuild when isRush", () => {
    const plan = computeQuickEditPlan(
      { ...baseCase, isRush: true },
      baseForm({ material: "PFM" }),
      () => 100,
    );
    expect(plan.newPrice).toBe(700);
    expect(plan.invoicePatch?.lineItems).toHaveLength(2);
    expect(plan.invoicePatch?.lineItems?.[1].item).toBe("Rush Fee");
  });

  it("skips invoice patch when there is no invoiceId", () => {
    const plan = computeQuickEditPlan(
      { ...baseCase, invoiceId: null },
      baseForm({ shade: "B1" }),
      () => 100,
    );
    expect(plan.invoicePatch).toBeUndefined();
  });

  it("treats empty notes as a clearing change", () => {
    const plan = computeQuickEditPlan(baseCase, baseForm({ notes: "" }), () => 100);
    expect(plan.changes).toEqual(["Notes updated"]);
    expect(plan.caseUpdates.notes).toBe("");
  });
});
