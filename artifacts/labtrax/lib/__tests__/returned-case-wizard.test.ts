/**
 * Unit tests for the returned-case wizard state machine + handoff store.
 *
 * These cover the "which question comes next" contract on its own so the
 * component tests only have to prove the panels are wired to it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  RETURNED_WIZARD_ORDER,
  clearPendingReturnedWizard,
  consumePendingReturnedWizard,
  firstReturnedWizardStage,
  isReturnedLocate,
  nextReturnedWizardStage,
  peekPendingReturnedWizard,
  setPendingReturnedWizard,
  type ReturnedWizardStage,
} from "@/lib/returned-case-wizard";

beforeEach(() => {
  clearPendingReturnedWizard();
});

/** Walks the machine from the top and collects every stage it visits. */
function walk(canChangeStep: boolean): ReturnedWizardStage[] {
  const seen: ReturnedWizardStage[] = [];
  let stage = firstReturnedWizardStage({ canChangeStep });
  while (stage) {
    seen.push(stage);
    stage = nextReturnedWizardStage(stage, { canChangeStep });
  }
  return seen;
}

describe("isReturnedLocate", () => {
  it("is true for every complete → intake pairing", async () => {
    for (const from of ["complete", "delivered", "done"]) {
      for (const to of ["received", "intake", "new", "pending"]) {
        expect(isReturnedLocate(from, to)).toBe(true);
      }
    }
  });

  it("ignores casing", async () => {
    expect(isReturnedLocate("Complete", "RECEIVED")).toBe(true);
  });

  it("is false when the case was not complete", async () => {
    expect(isReturnedLocate("in_progress", "received")).toBe(false);
    expect(isReturnedLocate("received", "pending")).toBe(false);
  });

  it("is false when the destination is not an intake station", async () => {
    expect(isReturnedLocate("complete", "in_progress")).toBe(false);
    expect(isReturnedLocate("complete", "delivered")).toBe(false);
  });

  it("is false for missing statuses", async () => {
    expect(isReturnedLocate(null, "received")).toBe(false);
    expect(isReturnedLocate("complete", undefined)).toBe(false);
  });
});

describe("returned wizard order", () => {
  it("asks all seven questions in the documented order", async () => {
    expect(walk(true)).toEqual([
      "dueDate",
      "rxScan",
      "remake",
      "removable",
      "notes",
      "printLabSlip",
      "printCaseLabel",
    ]);
    expect(walk(true)).toEqual([...RETURNED_WIZARD_ORDER]);
  });

  it("skips the removable question when the viewer cannot change the step", async () => {
    const stages = walk(false);
    expect(stages).not.toContain("removable");
    expect(stages).toEqual([
      "dueDate",
      "rxScan",
      "remake",
      "notes",
      "printLabSlip",
      "printCaseLabel",
    ]);
  });

  it("converges the remake and removable branches on the closing questions", async () => {
    // Both branches must lead to notes → prints rather than ending early.
    expect(nextReturnedWizardStage("remake", { canChangeStep: true })).toBe("removable");
    expect(nextReturnedWizardStage("remake", { canChangeStep: false })).toBe("notes");
    expect(nextReturnedWizardStage("removable", { canChangeStep: true })).toBe("notes");
    expect(nextReturnedWizardStage("notes", { canChangeStep: true })).toBe("printLabSlip");
    expect(nextReturnedWizardStage("printLabSlip", { canChangeStep: true })).toBe(
      "printCaseLabel",
    );
  });

  it("ends after the last question", async () => {
    expect(nextReturnedWizardStage("printCaseLabel", { canChangeStep: true })).toBeNull();
  });
});

describe("pending handoff store", () => {
  it("hands a stage to one specific case and clears on consumption", async () => {
    setPendingReturnedWizard("case-1", "notes");
    expect(peekPendingReturnedWizard()).toEqual({ caseId: "case-1", stage: "notes" });
    expect(consumePendingReturnedWizard("case-1")).toBe("notes");
    expect(consumePendingReturnedWizard("case-1")).toBeNull();
  });

  it("does not surrender the stage to a different case", async () => {
    setPendingReturnedWizard("case-1", "remake");
    expect(consumePendingReturnedWizard("case-2")).toBeNull();
    expect(consumePendingReturnedWizard("case-1")).toBe("remake");
  });

  it("clears without consuming", async () => {
    setPendingReturnedWizard("case-1", "dueDate");
    clearPendingReturnedWizard();
    expect(peekPendingReturnedWizard()).toBeNull();
  });
});
