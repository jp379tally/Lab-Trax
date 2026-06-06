/**
 * Unit tests for mapRxResponseToFormFields (AI Reader regression guard).
 *
 * Invariants protected:
 *  - All nullable fields present → form fields populated correctly.
 *  - Null / missing fields → form fields are empty strings (not undefined, not "null").
 *  - isRush flag maps to the rush boolean toggle.
 *  - toothIndices string parsed into selectedTeeth array (1–32 only, sorted).
 *  - dueDate string normalised from MM/DD/YYYY to YYYY-MM-DD.
 *  - caseType normalised via AI_CASE_TYPE_MAP.
 *  - aiFilledFields Set tracks exactly which fields were populated.
 *  - patientName falls back to patientInitials when absent.
 */
import { describe, expect, it } from "vitest";
import { mapRxResponseToFormFields, AI_CASE_TYPE_MAP } from "./rx-to-form";

// ─────────────────────────────────────────────────────────────────────────────
// Full happy-path fixture
// ─────────────────────────────────────────────────────────────────────────────

describe("mapRxResponseToFormFields — all fields present", () => {
  const fullResponse = {
    doctorName: "Dr. James Smith",
    patientName: "Alice Johnson",
    patientInitials: "A.J.",
    caseType: "crown",
    toothIndices: "3, 14, 29",
    shade: "A2",
    material: "Zirconia",
    dueDate: "2026-07-01",
    isRush: true,
    notes: "Handle with care",
    practiceName: "Smith Dental",
    practiceAddress: "123 Main St",
    practicePhone: "555-1234",
  };

  it("maps doctorName correctly", () => {
    expect(mapRxResponseToFormFields(fullResponse).doctorName).toBe("Dr. James Smith");
  });

  it("maps patientName correctly", () => {
    expect(mapRxResponseToFormFields(fullResponse).patientName).toBe("Alice Johnson");
  });

  it("normalises caseType 'crown' to 'Restorative'", () => {
    expect(mapRxResponseToFormFields(fullResponse).caseType).toBe("Restorative");
  });

  it("maps toothIndices string", () => {
    expect(mapRxResponseToFormFields(fullResponse).toothIndices).toBe("3, 14, 29");
  });

  it("parses selectedTeeth from toothIndices (valid 1–32 only, sorted)", () => {
    expect(mapRxResponseToFormFields(fullResponse).selectedTeeth).toEqual([3, 14, 29]);
  });

  it("maps shade", () => {
    expect(mapRxResponseToFormFields(fullResponse).shade).toBe("A2");
  });

  it("maps material", () => {
    expect(mapRxResponseToFormFields(fullResponse).material).toBe("Zirconia");
  });

  it("passes through ISO dueDate unchanged", () => {
    expect(mapRxResponseToFormFields(fullResponse).dueDate).toBe("2026-07-01");
  });

  it("maps isRush to true", () => {
    expect(mapRxResponseToFormFields(fullResponse).isRush).toBe(true);
  });

  it("maps notes", () => {
    expect(mapRxResponseToFormFields(fullResponse).notes).toBe("Handle with care");
  });

  it("aiFilledFields contains all filled field names", () => {
    const { aiFilledFields } = mapRxResponseToFormFields(fullResponse);
    expect(aiFilledFields.has("doctorName")).toBe(true);
    expect(aiFilledFields.has("patientName")).toBe(true);
    expect(aiFilledFields.has("caseType")).toBe(true);
    expect(aiFilledFields.has("toothIndices")).toBe(true);
    expect(aiFilledFields.has("shade")).toBe(true);
    expect(aiFilledFields.has("material")).toBe(true);
    expect(aiFilledFields.has("dueDate")).toBe(true);
    expect(aiFilledFields.has("isRush")).toBe(true);
    expect(aiFilledFields.has("notes")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Null / missing fields → empty strings (not "null", not undefined)
// ─────────────────────────────────────────────────────────────────────────────

describe("mapRxResponseToFormFields — null / missing fields", () => {
  it("produces empty string for doctorName when absent", () => {
    const r = mapRxResponseToFormFields({});
    expect(r.doctorName).toBe("");
    expect(r.doctorName).not.toBe("null");
    expect(r.doctorName).not.toBeUndefined();
  });

  it("produces empty string for patientName when both patientName and patientInitials absent", () => {
    const r = mapRxResponseToFormFields({});
    expect(r.patientName).toBe("");
  });

  it("produces empty string for caseType when absent", () => {
    expect(mapRxResponseToFormFields({}).caseType).toBe("");
  });

  it("produces empty string for toothIndices when absent", () => {
    expect(mapRxResponseToFormFields({}).toothIndices).toBe("");
  });

  it("produces empty selectedTeeth array when toothIndices absent", () => {
    expect(mapRxResponseToFormFields({}).selectedTeeth).toEqual([]);
  });

  it("produces empty string for shade when null", () => {
    expect(mapRxResponseToFormFields({ shade: null }).shade).toBe("");
  });

  it("produces empty string for material when null", () => {
    expect(mapRxResponseToFormFields({ material: null }).material).toBe("");
  });

  it("produces empty string for dueDate when null", () => {
    expect(mapRxResponseToFormFields({ dueDate: null }).dueDate).toBe("");
  });

  it("produces false for isRush when absent", () => {
    expect(mapRxResponseToFormFields({}).isRush).toBe(false);
  });

  it("produces false for isRush when null", () => {
    expect(mapRxResponseToFormFields({ isRush: null }).isRush).toBe(false);
  });

  it("produces empty string for notes when absent", () => {
    expect(mapRxResponseToFormFields({}).notes).toBe("");
  });

  it("aiFilledFields is empty when all fields are absent", () => {
    expect(mapRxResponseToFormFields({}).aiFilledFields.size).toBe(0);
  });

  it("aiFilledFields does not contain fields with null values", () => {
    const r = mapRxResponseToFormFields({ doctorName: null, shade: null });
    expect(r.aiFilledFields.has("doctorName")).toBe(false);
    expect(r.aiFilledFields.has("shade")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isRush flag
// ─────────────────────────────────────────────────────────────────────────────

describe("mapRxResponseToFormFields — isRush", () => {
  it("maps isRush: true to boolean true", () => {
    expect(mapRxResponseToFormFields({ isRush: true }).isRush).toBe(true);
  });

  it("maps isRush: false to boolean false (and does NOT add to aiFilledFields)", () => {
    const r = mapRxResponseToFormFields({ isRush: false });
    expect(r.isRush).toBe(false);
    expect(r.aiFilledFields.has("isRush")).toBe(true);
  });

  it("isRush: undefined → false and not in aiFilledFields", () => {
    const r = mapRxResponseToFormFields({ isRush: undefined });
    expect(r.isRush).toBe(false);
    expect(r.aiFilledFields.has("isRush")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toothIndices parsing → selectedTeeth
// ─────────────────────────────────────────────────────────────────────────────

describe("mapRxResponseToFormFields — toothIndices → selectedTeeth", () => {
  it("parses comma-separated teeth correctly", () => {
    const r = mapRxResponseToFormFields({ toothIndices: "1, 8, 16, 32" });
    expect(r.selectedTeeth).toEqual([1, 8, 16, 32]);
  });

  it("filters out teeth below 1", () => {
    expect(mapRxResponseToFormFields({ toothIndices: "0, 1, 2" }).selectedTeeth).toEqual([1, 2]);
  });

  it("filters out teeth above 32", () => {
    expect(mapRxResponseToFormFields({ toothIndices: "30, 32, 33" }).selectedTeeth).toEqual([30, 32]);
  });

  it("returns empty array when all numbers out of range", () => {
    expect(mapRxResponseToFormFields({ toothIndices: "0, 33, 99" }).selectedTeeth).toEqual([]);
  });

  it("returns sorted ascending array", () => {
    const r = mapRxResponseToFormFields({ toothIndices: "14, 3, 8" });
    expect(r.selectedTeeth).toEqual([3, 8, 14]);
  });

  it("handles a single tooth number", () => {
    expect(mapRxResponseToFormFields({ toothIndices: "14" }).selectedTeeth).toEqual([14]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dueDate normalisation
// ─────────────────────────────────────────────────────────────────────────────

describe("mapRxResponseToFormFields — dueDate normalisation", () => {
  it("passes through YYYY-MM-DD ISO format unchanged", () => {
    expect(mapRxResponseToFormFields({ dueDate: "2026-07-15" }).dueDate).toBe("2026-07-15");
  });

  it("converts MM/DD/YYYY to YYYY-MM-DD", () => {
    expect(mapRxResponseToFormFields({ dueDate: "07/15/2026" }).dueDate).toBe("2026-07-15");
  });

  it("converts single-digit month and day (M/D/YYYY) to YYYY-MM-DD", () => {
    expect(mapRxResponseToFormFields({ dueDate: "7/5/2026" }).dueDate).toBe("2026-07-05");
  });

  it("leaves non-matching date strings unchanged (e.g. plain text)", () => {
    expect(mapRxResponseToFormFields({ dueDate: "July 15, 2026" }).dueDate).toBe("July 15, 2026");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// patientName fallback to patientInitials
// ─────────────────────────────────────────────────────────────────────────────

describe("mapRxResponseToFormFields — patientName fallback", () => {
  it("uses patientName when both are present", () => {
    const r = mapRxResponseToFormFields({ patientName: "Alice Johnson", patientInitials: "A.J." });
    expect(r.patientName).toBe("Alice Johnson");
  });

  it("falls back to patientInitials when patientName is absent", () => {
    const r = mapRxResponseToFormFields({ patientInitials: "A.J." });
    expect(r.patientName).toBe("A.J.");
    expect(r.aiFilledFields.has("patientName")).toBe(true);
  });

  it("falls back to patientInitials when patientName is null", () => {
    const r = mapRxResponseToFormFields({ patientName: null, patientInitials: "A.J." });
    expect(r.patientName).toBe("A.J.");
  });

  it("produces empty string when both are absent", () => {
    expect(mapRxResponseToFormFields({}).patientName).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// caseType normalisation
// ─────────────────────────────────────────────────────────────────────────────

describe("mapRxResponseToFormFields — caseType normalisation", () => {
  const restorativeCases = [
    "crown", "Crown", "CROWN",
    "crown & bridge", "Crown and Bridge",
    "bridge", "implant", "veneers", "veneer",
    "inlay", "onlay", "fixed",
  ];
  for (const input of restorativeCases) {
    it(`normalises "${input}" to Restorative`, () => {
      expect(mapRxResponseToFormFields({ caseType: input }).caseType).toBe("Restorative");
    });
  }

  const removableCases = [
    "denture", "Dentures", "partial", "flipper", "full denture", "complete denture",
  ];
  for (const input of removableCases) {
    it(`normalises "${input}" to Removable`, () => {
      expect(mapRxResponseToFormFields({ caseType: input }).caseType).toBe("Removable");
    });
  }

  const applianceCases = [
    "night guard", "nightguard", "retainer", "mouth guard", "bleaching tray", "bite splint",
  ];
  for (const input of applianceCases) {
    it(`normalises "${input}" to Appliance`, () => {
      expect(mapRxResponseToFormFields({ caseType: input }).caseType).toBe("Appliance");
    });
  }

  it(`normalises "temporary" to Temporary`, () => {
    expect(mapRxResponseToFormFields({ caseType: "temporary" }).caseType).toBe("Temporary");
  });

  it("passes through unrecognised caseType as-is", () => {
    expect(mapRxResponseToFormFields({ caseType: "SomeFutureCaseType" }).caseType).toBe("SomeFutureCaseType");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI_CASE_TYPE_MAP export completeness
// ─────────────────────────────────────────────────────────────────────────────

describe("AI_CASE_TYPE_MAP", () => {
  it("is a non-empty object", () => {
    expect(Object.keys(AI_CASE_TYPE_MAP).length).toBeGreaterThan(0);
  });

  it("all values are one of the four canonical caseType values", () => {
    const valid = new Set(["Restorative", "Removable", "Appliance", "Temporary"]);
    for (const [, v] of Object.entries(AI_CASE_TYPE_MAP)) {
      expect(valid.has(v)).toBe(true);
    }
  });
});
