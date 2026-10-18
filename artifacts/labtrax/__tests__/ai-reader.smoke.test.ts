// Smoke tests for the AI Reader intake workflow (Task #1503).
//
// These tests verify the module-level store, the PDF-from-pages helper shape,
// and the key data transformations without requiring a real device or AI key.
// Server-side coverage lives in artifacts/api-server (analyze-prescription.test.ts,
// cases-ai-reader.test.ts). Real-device flows are covered by the TestFlight checklist.

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearAiReaderSession,
  getAiReaderSession,
  setAiReaderSession,
  type CapturedPage,
  type ExtractedRx,
  type AiReaderRestoration,
} from "../lib/ai-reader-store";

describe("AiReaderStore", () => {
  beforeEach(() => {
    clearAiReaderSession();
  });

  it("starts with an empty session", () => {
    const s = getAiReaderSession();
    expect(s.pages).toEqual([]);
    expect(s.extracted).toBeNull();
    expect(s.caseId).toBeNull();
    expect(s.caseNumber).toBeNull();
    expect(s.restorations).toEqual([]);
    expect(s.labName).toBeNull();
    expect(s.doctorName).toBeNull();
    expect(s.patientName).toBeNull();
    expect(s.dueDate).toBeNull();
  });

  it("setAiReaderSession merges without overwriting unrelated fields", () => {
    const page: CapturedPage = { uri: "file://test.jpg", base64: "data:image/jpeg;base64,abc" };
    setAiReaderSession({ pages: [page] });
    setAiReaderSession({ caseNumber: "26-42" });
    const s = getAiReaderSession();
    expect(s.pages).toHaveLength(1);
    expect(s.caseNumber).toBe("26-42");
    expect(s.caseId).toBeNull();
    // New label fields still empty
    expect(s.labName).toBeNull();
    expect(s.restorations).toEqual([]);
  });

  it("clearAiReaderSession resets all fields", () => {
    const page: CapturedPage = { uri: "file://test.jpg", base64: "data:image/jpeg;base64,abc" };
    const rx: ExtractedRx = {
      doctorName: "Dr. Synthetic063",
      patientName: "Jane Doe",
      patientInitials: "JD",
      caseType: "Crown & Bridge",
      toothIndices: "3, 14",
      shade: "A2",
      material: "Zirconia",
      dueDate: "2026-07-01",
      isRush: false,
      notes: null,
      practiceName: "Smith Dental",
      practiceAddress: null,
      practicePhone: null,
      confidence: 0.92,
      step: null,
      gingivialShade: null,
    };
    const restorations: AiReaderRestoration[] = [
      { toothNumber: "3", restorationType: "Crown & Bridge", material: "Zirconia", shade: "A2" },
    ];
    setAiReaderSession({
      pages: [page],
      extracted: rx,
      caseId: "abc-123",
      caseNumber: "26-42",
      restorations,
      labName: "Acme Lab",
      doctorName: "Dr. Synthetic063",
      patientName: "Jane Doe",
      dueDate: "2026-07-01",
    });
    clearAiReaderSession();
    const s = getAiReaderSession();
    expect(s.pages).toEqual([]);
    expect(s.extracted).toBeNull();
    expect(s.caseId).toBeNull();
    expect(s.caseNumber).toBeNull();
    expect(s.restorations).toEqual([]);
    expect(s.labName).toBeNull();
    expect(s.doctorName).toBeNull();
    expect(s.patientName).toBeNull();
    expect(s.dueDate).toBeNull();
  });

  it("stores multiple pages in insertion order", () => {
    const p1: CapturedPage = { uri: "file://p1.jpg", base64: "data:image/jpeg;base64,aaa" };
    const p2: CapturedPage = { uri: "file://p2.jpg", base64: "data:image/jpeg;base64,bbb" };
    setAiReaderSession({ pages: [p1, p2] });
    expect(getAiReaderSession().pages[0].uri).toBe("file://p1.jpg");
    expect(getAiReaderSession().pages[1].uri).toBe("file://p2.jpg");
  });

  it("stores restorations for label printing", () => {
    const restorations: AiReaderRestoration[] = [
      { toothNumber: "3", restorationType: "Crown & Bridge", material: "Zirconia", shade: "A2" },
      { toothNumber: "14", restorationType: "Crown & Bridge" },
    ];
    setAiReaderSession({ restorations });
    expect(getAiReaderSession().restorations).toHaveLength(2);
    expect(getAiReaderSession().restorations[0].toothNumber).toBe("3");
  });

  it("session is shared across get/set calls (module-level singleton)", () => {
    setAiReaderSession({ labName: "Test Lab" });
    // Simulate reading from a different "screen"
    const s2 = getAiReaderSession();
    expect(s2.labName).toBe("Test Lab");
  });
});

// ── Name-parsing helpers (duplicated from extracted.tsx for unit coverage) ───

function splitName(full: string | null | undefined): { first: string; last: string } {
  if (!full?.trim()) return { first: "", last: "" };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function parseDueDateMDY(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return raw;
  const [, mo, dy, yr] = m;
  const fullYr = yr.length === 2 ? `20${yr}` : yr;
  return `${fullYr}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}`;
}

describe("AI Reader extracted field helpers", () => {
  describe("splitName", () => {
    it("splits two-part name", () => {
      expect(splitName("Jane Doe")).toEqual({ first: "Jane", last: "Doe" });
    });
    it("handles single word", () => {
      expect(splitName("Cher")).toEqual({ first: "Cher", last: "" });
    });
    it("handles multi-word last name", () => {
      expect(splitName("Mary Jane Watson")).toEqual({ first: "Mary", last: "Jane Watson" });
    });
    it("returns empty strings for null", () => {
      expect(splitName(null)).toEqual({ first: "", last: "" });
    });
    it("returns empty strings for blank", () => {
      expect(splitName("   ")).toEqual({ first: "", last: "" });
    });
  });

  describe("parseDueDateMDY", () => {
    it("converts MM/DD/YYYY to ISO format", () => {
      expect(parseDueDateMDY("07/15/2026")).toBe("2026-07-15");
    });
    it("pads single-digit month and day", () => {
      expect(parseDueDateMDY("7/5/2026")).toBe("2026-07-05");
    });
    it("handles 2-digit year", () => {
      expect(parseDueDateMDY("07/15/26")).toBe("2026-07-15");
    });
    it("returns raw string if not M/D/Y format", () => {
      expect(parseDueDateMDY("2026-07-15")).toBe("2026-07-15");
    });
    it("returns empty string for null", () => {
      expect(parseDueDateMDY(null)).toBe("");
    });
  });
});

// ── Capture session isolation (new=1 vs re-entry) ────────────────────────────

describe("Capture session isolation", () => {
  it("clearAiReaderSession wipes pages so new=1 starts fresh", () => {
    const page: CapturedPage = { uri: "file://existing.jpg", base64: "data:image/jpeg;base64,xyz" };
    setAiReaderSession({ pages: [page] });
    expect(getAiReaderSession().pages).toHaveLength(1);
    // Simulate `new=1` navigation clearing session
    clearAiReaderSession();
    expect(getAiReaderSession().pages).toHaveLength(0);
  });

  it("re-entry without clear preserves existing pages", () => {
    const p1: CapturedPage = { uri: "file://p1.jpg", base64: "data:image/jpeg;base64,aaa" };
    setAiReaderSession({ pages: [p1] });
    // Simulate navigating back from review to add more pages (no clearAiReaderSession)
    const p2: CapturedPage = { uri: "file://p2.jpg", base64: "data:image/jpeg;base64,bbb" };
    const existing = getAiReaderSession().pages;
    setAiReaderSession({ pages: [...existing, p2] });
    expect(getAiReaderSession().pages).toHaveLength(2);
    expect(getAiReaderSession().pages[0].uri).toBe("file://p1.jpg");
    expect(getAiReaderSession().pages[1].uri).toBe("file://p2.jpg");
  });

  it("retake replaces the page at the correct index", () => {
    const p1: CapturedPage = { uri: "file://p1.jpg", base64: "data:image/jpeg;base64,aaa" };
    const p2: CapturedPage = { uri: "file://p2.jpg", base64: "data:image/jpeg;base64,bbb" };
    setAiReaderSession({ pages: [p1, p2] });
    // Simulate retake of page index 0
    const retakeIdx = 0;
    const newPhoto: CapturedPage = { uri: "file://p1-new.jpg", base64: "data:image/jpeg;base64,ccc" };
    const updated = [...getAiReaderSession().pages];
    updated[retakeIdx] = newPhoto;
    setAiReaderSession({ pages: updated });
    expect(getAiReaderSession().pages[0].uri).toBe("file://p1-new.jpg");
    expect(getAiReaderSession().pages[1].uri).toBe("file://p2.jpg");
  });
});

// ── userOverrides — AI fill does not overwrite user-edited fields ─────────────

describe("AiReaderUserOverrides — field protection", () => {
  beforeEach(() => {
    clearAiReaderSession();
  });

  it("fresh session has empty userOverrides", () => {
    const s = getAiReaderSession();
    expect(s.userOverrides).toEqual({});
  });

  it("setAiReaderSession stores userOverrides", () => {
    setAiReaderSession({ userOverrides: { shade: "B2", material: "Zirconia" } });
    const s = getAiReaderSession();
    expect(s.userOverrides.shade).toBe("B2");
    expect(s.userOverrides.material).toBe("Zirconia");
  });

  it("userOverrides survive a subsequent setAiReaderSession({ extracted })", () => {
    // Simulate: user edits shade on extracted screen, then goes back to capture
    // and triggers re-analysis — the store only updates `extracted`, leaving
    // userOverrides intact so the screen re-initializes from the user's value.
    setAiReaderSession({ userOverrides: { shade: "B2" } });

    const newExtracted: ExtractedRx = {
      doctorName: "Dr. Test",
      patientName: null,
      patientInitials: null,
      caseType: "Crown & Bridge",
      toothIndices: "3",
      shade: "A1",
      material: "Zirconia",
      dueDate: null,
      isRush: false,
      notes: null,
      practiceName: null,
      practiceAddress: null,
      practicePhone: null,
      confidence: 0.9,
      step: null,
      gingivialShade: null,
    };
    setAiReaderSession({ extracted: newExtracted });

    const s = getAiReaderSession();
    // User's shade override is still B2 — AI's A1 did NOT overwrite it
    expect(s.userOverrides.shade).toBe("B2");
    expect(s.extracted?.shade).toBe("A1");
  });

  it("field initialization prefers userOverride over extracted value", () => {
    // Simulates the useState initializer logic in extracted.tsx
    const overrides = { shade: "B2" };
    const extractedShade = "A1";
    const initialShade =
      overrides.shade !== undefined ? overrides.shade : (extractedShade ?? "");
    expect(initialShade).toBe("B2");
  });

  it("field initialization uses extracted value when no override is set", () => {
    const overrides: Record<string, string> = {};
    const extractedShade = "A1";
    const initialShade =
      overrides.shade !== undefined ? overrides.shade : (extractedShade ?? "");
    expect(initialShade).toBe("A1");
  });

  it("an empty-string override is respected (user intentionally cleared the field)", () => {
    // The user deleted the pre-filled shade — empty string must NOT fall back to
    // the AI value on a re-scan.
    const overrides = { shade: "" };
    const extractedShade = "A1";
    const initialShade =
      overrides.shade !== undefined ? overrides.shade : (extractedShade ?? "");
    expect(initialShade).toBe("");
  });

  it("clearAiReaderSession wipes userOverrides so the next scan starts fresh", () => {
    setAiReaderSession({ userOverrides: { shade: "B2", material: "Zirconia" } });
    clearAiReaderSession();
    const s = getAiReaderSession();
    expect(s.userOverrides).toEqual({});
  });

  it("merging a second override field leaves prior override fields intact", () => {
    setAiReaderSession({ userOverrides: { shade: "B2" } });
    // Simulate saveOverride("material", "Emax") merging into existing overrides
    const session = getAiReaderSession();
    setAiReaderSession({
      userOverrides: { ...session.userOverrides, material: "Emax" },
    });
    const s = getAiReaderSession();
    expect(s.userOverrides.shade).toBe("B2");
    expect(s.userOverrides.material).toBe("Emax");
  });

  it("AI fill does not overwrite shade when the field was dirtied before re-analysis", () => {
    // Full end-to-end simulation of the bug scenario:
    // 1. First scan: AI returns shade A1 → screen initializes shade from extracted
    // 2. User edits shade to B2 → saveOverride persists it
    // 3. User goes back, scans again → AI returns A3 (different result)
    // 4. Screen remounts: should use B2 (user override), not A3 (new AI value)

    // Step 1 — first analysis result arrives
    const firstExtracted: ExtractedRx = {
      doctorName: null, patientName: null, patientInitials: null,
      caseType: "Crown & Bridge", toothIndices: "3",
      shade: "A1", material: "Zirconia",
      dueDate: null, isRush: false, notes: null,
      practiceName: null, practiceAddress: null, practicePhone: null,
      confidence: 0.9,
      step: null,
      gingivialShade: null,
    };
    setAiReaderSession({ extracted: firstExtracted });

    // Simulate: initial shade value the component would read
    let s = getAiReaderSession();
    const shadeAfterFirstScan =
      s.userOverrides.shade !== undefined ? s.userOverrides.shade : (s.extracted?.shade ?? "");
    expect(shadeAfterFirstScan).toBe("A1");

    // Step 2 — user edits shade to B2 (saveOverride is called)
    setAiReaderSession({ userOverrides: { ...s.userOverrides, shade: "B2" } });

    // Step 3 — re-scan produces a different AI shade
    const secondExtracted: ExtractedRx = { ...firstExtracted, shade: "A3" };
    setAiReaderSession({ extracted: secondExtracted });

    // Step 4 — screen remounts: reads override first
    s = getAiReaderSession();
    const shadeAfterRescan =
      s.userOverrides.shade !== undefined ? s.userOverrides.shade : (s.extracted?.shade ?? "");
    expect(shadeAfterRescan).toBe("B2"); // user's edit preserved
    expect(s.extracted?.shade).toBe("A3"); // AI result is stored but not applied
  });
});

// ── Barcode-print session → PDF contract ─────────────────────────────────────
// Verifies that gingival shade stored in the session reaches buildCaseCardHtml
// and that it is omitted when absent (the two states that the barcode print
// screen delegates through without any extra transformation).

describe("AiReaderSession → barcode PDF: gingivialShade contract", () => {
  beforeEach(() => {
    clearAiReaderSession();
  });

  it("session gingivialShade is present in the generated HTML when set", async () => {
    const { buildCaseCardHtml } = await import("../lib/case-pdf");
    setAiReaderSession({ gingivialShade: "Medium Pink" });
    const s = getAiReaderSession();
    const html = buildCaseCardHtml({ caseNumber: "5100", gingivialShade: s.gingivialShade });
    expect(html).toContain("Gingival Shade");
    expect(html).toContain("Medium Pink");
  });

  it("session gingivialShade is absent from the generated HTML when null", async () => {
    const { buildCaseCardHtml } = await import("../lib/case-pdf");
    setAiReaderSession({ gingivialShade: null });
    const s = getAiReaderSession();
    const html = buildCaseCardHtml({ caseNumber: "5101", gingivialShade: s.gingivialShade });
    expect(html).not.toContain("Gingival Shade");
  });

  it("ExtractedRx gingivialShade survives a setAiReaderSession round-trip", () => {
    const rx: ExtractedRx = {
      doctorName: null, patientName: null, patientInitials: null,
      caseType: "Removable", toothIndices: null,
      shade: null, material: null, dueDate: null,
      isRush: null, notes: null, practiceName: null,
      practiceAddress: null, practicePhone: null, confidence: null,
      step: null, gingivialShade: "Light Pink",
    };
    setAiReaderSession({ extracted: rx });
    expect(getAiReaderSession().extracted?.gingivialShade).toBe("Light Pink");
  });
});

// ── OpenAPI codegen guard ─────────────────────────────────────────────────────

describe("OpenAPI codegen guard — AI Reader hooks", () => {
  it("analyzePrescription is exported from api-client-react", async () => {
    const mod = await import("@workspace/api-client-react");
    const m = mod as Record<string, unknown>;
    expect(m.useAnalyzePrescription ?? m.analyzePrescription).toBeDefined();
  });

  it("getPatientSimilarity is exported from api-client-react", async () => {
    const mod = await import("@workspace/api-client-react");
    const m = mod as Record<string, unknown>;
    expect(m.useGetPatientSimilarity ?? m.getPatientSimilarity ?? m.useGetCasesPatientSimilarity).toBeDefined();
  });
});
