import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { caseLocationLabel } from "@/pages/dashboard";
import { remakeChainLocationLabel } from "@/pages/cases";

describe("case location mutation refresh contract", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../cases.tsx"),
    "utf8",
  );

  it("awaits authoritative list and detail refresh after a single move", () => {
    const mutation = source.slice(
      source.indexOf("const routeMutation = useMutation"),
      source.indexOf("const priorityMutation = useMutation"),
    );
    expect(mutation).toContain("onSuccess: async");
    expect(mutation).toContain('qc.invalidateQueries({ queryKey: ["cases"] })');
    expect(mutation).toContain(
      'qc.invalidateQueries({ queryKey: ["case", labCase.id] })',
    );
    expect(mutation).toContain("await Promise.all");
  });

  it("sends the physical station id and refreshes every affected detail after a bulk move", () => {
    const mutation = source.slice(
      source.indexOf("const bulkStatusMutation = useMutation"),
      source.indexOf("const [bulkToast"),
    );
    expect(mutation).toContain("labLocationId?: string | null");
    expect(mutation).toContain("onSuccess: async");
    expect(mutation).toContain("...variables.caseIds.map");
    expect(mutation).toContain(
      'qc.invalidateQueries({ queryKey: ["case", caseId] })',
    );
    expect(source).toContain("{ labLocationId: bulkStatusValue }");
  });

  it("prefers the case's exact physical station over the workflow status", () => {
    const locations = [
      { id: "station-a", value: "received", label: "Intake A" },
      { id: "station-b", value: "received", label: "Intake B" },
    ];
    expect(
      caseLocationLabel(
        { status: "received", labLocationId: "station-b", labLocationName: null },
        locations,
      ),
    ).toBe("Intake B");
    expect(
      caseLocationLabel(
        { status: "received", labLocationId: "station-b", labLocationName: "Recorded Intake" },
        locations,
      ),
    ).toBe("Recorded Intake");
  });

  it("keeps original and remake station labels independent", () => {
    const locations = [
      { id: "original-station", label: "Original Intake" },
      { id: "remake-station", label: "Remake QC" },
    ];
    expect(
      remakeChainLocationLabel(
        { status: "received", labLocationId: "original-station" },
        locations,
      ),
    ).toBe("Original Intake");
    expect(
      remakeChainLocationLabel(
        { status: "received", labLocationId: "remake-station" },
        locations,
      ),
    ).toBe("Remake QC");
  });

  it("refreshes the remake chain after a single move", () => {
    const mutation = source.slice(
      source.indexOf("const routeMutation = useMutation"),
      source.indexOf("const priorityMutation = useMutation"),
    );
    expect(mutation).toContain(
      'qc.invalidateQueries({ queryKey: ["case-remake-chain", labCase.id] })',
    );
  });
});