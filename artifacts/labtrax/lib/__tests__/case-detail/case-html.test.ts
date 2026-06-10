import { describe, it, expect } from "vitest";
import { buildCaseLabelHtml, buildCaseHistoryHtml } from "../../case-detail/case-html";
import type { LabCase } from "../../data";

const baseCase = {
  caseNumber: "26-12",
  patientName: "Jane Doe",
  patientInitials: "J.D.",
  doctorName: "Dr. Smith (12345)",
  toothIndices: "#8, #9",
  shade: "A2",
  material: "Zirconia",
  dueDate: "2026-06-01",
  notes: "Verify margins",
  status: "in_design" as const,
  createdAt: 1717200000000,
  activityLog: [],
  routeHistory: [],
} as unknown as LabCase;

describe("buildCaseLabelHtml", () => {
  it("includes the patient, doctor (cleaned) and notes row", () => {
    const html = buildCaseLabelHtml(baseCase);
    expect(html).toContain("Case #26-12");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("Dr. Smith Acct #12345");
    expect(html).toContain("Verify margins");
  });
  it("omits the notes row when empty", () => {
    const html = buildCaseLabelHtml({ ...baseCase, notes: "" });
    expect(html).not.toContain("Notes:");
  });
  it("falls back to initials when patient name is missing", () => {
    const html = buildCaseLabelHtml({ ...baseCase, patientName: "" });
    expect(html).toContain("J.D.");
  });
});

describe("buildCaseHistoryHtml", () => {
  const fixedNow = new Date("2026-05-13T12:00:00Z");

  it("renders the empty-state when there is no activity or route history", () => {
    const html = buildCaseHistoryHtml({ caseItem: baseCase, now: fixedNow });
    expect(html).toContain("No history entries yet.");
    expect(html).toContain("0 entries");
  });

  it("renders activity entries sorted by timestamp with mapped labels", () => {
    const html = buildCaseHistoryHtml({
      caseItem: {
        ...baseCase,
        activityLog: [
          { id: "b", type: "note", timestamp: 2000, description: "Second", user: "alice" },
          { id: "a", type: "created", timestamp: 1000, description: "First", user: "bob" },
        ] as LabCase["activityLog"],
      },
      registeredUsers: [
        { id: "u1", username: "alice", firstName: "Alice", lastName: "Lee" },
      ],
      now: fixedNow,
    });
    expect(html).toContain("Created");
    expect(html).toContain("Note");
    expect(html).toContain("Alice Lee");
    expect(html).toContain("Second");
    expect(html).toContain("2 entries");
  });

  it("escapes HTML-unsafe characters in user content", () => {
    const html = buildCaseHistoryHtml({
      caseItem: {
        ...baseCase,
        activityLog: [
          { id: "x", type: "note", timestamp: 1000, description: "<script>x</script>" },
        ] as LabCase["activityLog"],
      },
      now: fixedNow,
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to route history when activity log is empty", () => {
    const html = buildCaseHistoryHtml({
      caseItem: {
        ...baseCase,
        activityLog: [],
        routeHistory: [{ station: "in_milling", timestamp: 5000 }],
      },
      now: fixedNow,
    });
    expect(html).toContain("Case moved to Mill");
  });
});
