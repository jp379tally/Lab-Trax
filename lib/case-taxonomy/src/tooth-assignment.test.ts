import { describe, expect, it } from "vitest";
import {
  areUniversalTeethAdjacent,
  parseConnectorState,
  serializeConnectorState,
  suggestPonticConnectorPairs,
  validateToothConnectors,
  expandToothAssignmentIdentifiers,
  copyToothAssignment,
  withPonticConnectorSuggestions,
  updateConnectorChoices,
  normalizeLegacyDesktopConnectorEcho,
  toothAssignmentSummary,
  readExplicitAiToothAssignments,
  invalidToothAssignmentTokens,
  describeToothAssignments,
} from "./tooth-assignment";

describe("tooth assignment connectors", () => {
  it("keeps malformed legacy connections visible during unrelated unit edits", () => {
    const graph = withPonticConnectorSuggestions("invalid-edge,2-4", [
      { toothNumber: "2", restorationType: "Crown", material: "Zirconia", quantity: 1 },
    ]);
    expect(serializeConnectorState(graph)).toContain("invalid-edge");
    expect(validateToothConnectors(serializeConnectorState(graph), []).errors.length).toBeGreaterThan(0);
  });
  it("accepts only explicit per-tooth AI roles, material, shade and bound evidence", () => {
    const unit = { toothNumber: "2", role: "prepared_crown", material: "Zirconia", shade: "A2", roleEvidence: "Prepared crowns #2 and #4", requiresReview: false };
    expect(readExplicitAiToothAssignments([unit])).toMatchObject([{ toothNumber: "2", restorationType: "Crown", assignmentProvenance: { origin: "ai_explicit", manualFields: [] } }]);
    expect(readExplicitAiToothAssignments([{ ...unit, toothNumber: "4" }])).toMatchObject([{ toothNumber: "4", restorationType: "Crown" }]);
    for (const change of [
      { roleEvidence: "Bridge #2-4" }, { roleEvidence: "Prepared crown #4" },
      { roleEvidence: "Crowns #2 and #4 with pontic #3" }, { shade: null },
      { material: null }, { requiresReview: true }, { role: "unknown" },
    ]) expect(readExplicitAiToothAssignments([{ ...unit, ...change }])).toEqual([]);
    expect(readExplicitAiToothAssignments([unit, { ...unit, role: "pontic", roleEvidence: "Pontic #2" }])).toEqual([]);
  });

  it("keeps adjacent crowns independent and preserves an explicit disconnect across reload and new suggestions", () => {
    const units = [2, 3, 4].map((tooth) => ({ toothNumber: String(tooth), restorationType: "Crown", material: "Zirconia" }));
    expect(withPonticConnectorSuggestions(null, units).active.size).toBe(0);
    const connected = updateConnectorChoices(parseConnectorState(null), new Set(["2-3"]));
    expect(parseConnectorState(connected).explicitOn).toEqual(new Set(["2-3"]));
    const off = updateConnectorChoices(parseConnectorState(connected), new Set());
    const changed = units.map((unit) => ({ ...unit, restorationType: unit.toothNumber === "3" ? "Pontic" : "Crown" }));
    expect(withPonticConnectorSuggestions(off, changed).active).toEqual(new Set(["3-4"]));
    expect(withPonticConnectorSuggestions("?2-3,?3-4", units).active.size).toBe(0);
    expect(withPonticConnectorSuggestions("2-3,3-4", units).active).toEqual(new Set(["2-3", "3-4"]));
  });

  it("prints the same explicit #2–4 roles, group and three units without reinterpreting legacy rows", () => {
    const units = ["Crown", "Pontic", "Crown"].map((restorationType, index) => ({ toothNumber: String(index + 2), restorationType, material: "Zirconia", shade: "A2" }));
    const text = describeToothAssignments(units, "?2-3,?3-4");
    expect(text).toContain("3 units");
    expect(text).toContain("#2");
    expect(text).toMatch(/prepared crown/i);
    expect(text).toMatch(/pontic/i);
    expect(toothAssignmentSummary([{ toothNumber: "2-4", restorationType: "Crown & Bridge", material: "Zirconia" }], null).units).toBe(0);
    expect(invalidToothAssignmentTokens("2-4,16-17,33,J-K")).toEqual(["16-17", "33", "J-K"]);
  });
  it("keeps Universal landmarks adjacent without joining the arches", () => {
    expect(areUniversalTeethAdjacent(8, 9)).toBe(true);
    expect(areUniversalTeethAdjacent(24, 25)).toBe(true);
    expect(areUniversalTeethAdjacent(16, 17)).toBe(false);
  });

  it("round-trips explicit on/off and suggested edge provenance", () => {
    const parsed = parseConnectorState("2-3,?3-4,!4-5");
    expect(parsed.active).toEqual(new Set(["2-3", "3-4"]));
    expect(parsed.explicitOn).toEqual(new Set(["2-3"]));
    expect(parsed.suggested).toEqual(new Set(["3-4"]));
    expect(parsed.explicitOff).toEqual(new Set(["4-5"]));
    expect(parseConnectorState(serializeConnectorState(parsed))).toEqual(parsed);
  });

  it("normalizes only an older desktop marker echo that conflicts with a plain edge", () => {
    // The old parser split at "-" and sorted endpoint strings, moving the
    // marker into the right endpoint: "?2-3" -> "3-?2", "!2-3" -> "3-!2".
    expect(normalizeLegacyDesktopConnectorEcho("?2-3,!3-4", "3-?2,!3-4"))
      .toBe(serializeConnectorState(parseConnectorState("?2-3,!3-4")));
    expect(normalizeLegacyDesktopConnectorEcho("?2-3,?3-4", "2-3,3-?2,4-?3"))
      .toBe(serializeConnectorState(parseConnectorState("2-3,?3-4")));
    expect(normalizeLegacyDesktopConnectorEcho("!2-3,?3-4", "2-3,!2-3,4-?3"))
      .toBe(serializeConnectorState(parseConnectorState("2-3,?3-4")));
    // New-client state transitions remain unchanged when each pair has one state.
    expect(normalizeLegacyDesktopConnectorEcho("?3-4", "!2-3,?3-4,4-5"))
      .toBe("!2-3,?3-4,4-5");
    // An unrecognized marker artifact is not normalized or accepted broadly.
    expect(normalizeLegacyDesktopConnectorEcho("?2-3", "3-?4")).toBe("3-?4");
  });

  it("suggests only compatible pontic-to-crown edges and rejects unresolved edges", () => {
    const units = [
      { toothNumber: "2", restorationType: "Crown", material: "Zirconia" },
      { toothNumber: "3", restorationType: "Pontic", material: "Zirconia" },
      { toothNumber: "4", restorationType: "Crown", material: "Zirconia" },
    ];
    expect(suggestPonticConnectorPairs(units)).toEqual(new Set(["2-3", "3-4"]));
    expect(validateToothConnectors("2-3,3-4", units)).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateToothConnectors("2-3,3-4", units.map((unit) => ({
      ...unit,
      material: unit.toothNumber === "3" ? null : unit.material,
    })).slice(1))).toEqual({
      valid: false,
      errors: expect.arrayContaining(["Connector #2–#3 has an unassigned tooth.", "Connector #3–#4 needs a catalog material on both units."]),
    });
  });

  it("rejects non-adjacent, missing, and product-incompatible connectors", () => {
    const units = [
      { toothNumber: "2", restorationType: "Crown", material: "Zirconia" },
      { toothNumber: "4", restorationType: "Crown", material: "Zirconia" },
    ];
    expect(validateToothConnectors("2-4", units).valid).toBe(false);
    expect(validateToothConnectors("2-3", units).errors[0]).toContain("unassigned");
    expect(validateToothConnectors("2-3", [
      ...units,
      { toothNumber: "3", restorationType: "Pontic", material: "PFM" },
    ]).errors.join(" ")).toContain("incompatible materials");
    expect(parseConnectorState("16-17,1-33").active.size).toBe(0);
  });

  it("expands only same-arch ranges, and copies values without identities", () => {
    expect(expandToothAssignmentIdentifiers("2-4,24-25")).toEqual(["2", "3", "4", "24", "25"]);
    expect(expandToothAssignmentIdentifiers("16-17,J-K")).toEqual([]);
    const source = { id: "old", connectorId: "old-edge", toothNumber: "2", restorationType: "Crown", material: "Zirconia", shade: "A2" };
    const copy = copyToothAssignment(source, "4");
    expect(copy).toMatchObject({ toothNumber: "4", restorationType: "Crown", material: "Zirconia", shade: "A2" });
    expect(copy).not.toHaveProperty("id");
    expect(copy).not.toHaveProperty("connectorId");
  });

  it("connects multiple explicit pontics, honors a disconnect, and reports unresolved pontics", () => {
    const units = ["Crown", "Pontic", "Pontic", "Crown"].map((restorationType, index) => ({
      toothNumber: String(index + 2), restorationType, material: "Zirconia",
    }));
    const suggested = withPonticConnectorSuggestions(null, units);
    expect(suggested.active).toEqual(new Set(["2-3", "3-4", "4-5"]));
    expect(toothAssignmentSummary(units, serializeConnectorState(suggested))).toMatchObject({
      units: 4, crowns: 2, pontics: 2, unresolvedPontics: [], groups: [["2", "3", "4", "5"]],
    });
    const off = updateConnectorChoices(suggested, new Set(["3-4"]));
    expect(withPonticConnectorSuggestions(off, units).active).toEqual(new Set(["3-4"]));
    expect(toothAssignmentSummary(units, off).unresolvedPontics).toEqual(["3", "4"]);
  });
});

it("keeps existing primary-tooth assignments and same-arch topology", () => {
  const units = [
    { toothNumber: "A", restorationType: "Crown", material: "Zirconia" },
    { toothNumber: "B", restorationType: "Pontic", material: "Zirconia" },
    { toothNumber: "C", restorationType: "Crown", material: "Zirconia" },
  ];
  expect(suggestPonticConnectorPairs(units)).toEqual(new Set(["A-B", "B-C"]));
  expect(validateToothConnectors("?A-B,!B-C", units).valid).toBe(true);
  expect(toothAssignmentSummary(units, "?A-B,!B-C")).toMatchObject({ units: 3, crowns: 2, pontics: 1, groups: [["A", "B"]] });
  expect(validateToothConnectors("J-K", units).valid).toBe(false);
});

it("does not mistake a shade or a price for tooth evidence", () => {
  for (const roleEvidence of ["Crown, shade A2", "Crown $2", "No crown #2"]) {
    expect(readExplicitAiToothAssignments([{ toothNumber: "2", role: "prepared_crown", material: "Zirconia", shade: "A2", roleEvidence, requiresReview: false }])).toEqual([]);
  }
});
