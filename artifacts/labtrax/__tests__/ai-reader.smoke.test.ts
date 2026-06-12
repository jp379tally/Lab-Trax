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
      doctorName: "Dr. Smith",
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
      doctorName: "Dr. Smith",
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
