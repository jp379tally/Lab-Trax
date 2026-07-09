/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CasesPage from "@/pages/cases";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";

// Task #2796: shift-click range selection on the Cases list. After a normal
// checkbox click sets the anchor, shift-clicking another row's checkbox
// selects every case between them in the currently visible (filtered +
// sorted) order. Covers: range down, range up, additive behavior, filtered
// order, and anchor reset when the anchor is filtered out.

function withAiPanel(children: React.ReactNode) {
  return (
    <AiPanelContext.Provider value={{ openPanel: () => {} }}>
      {children}
    </AiPanelContext.Provider>
  );
}

// jspdf and react-pdf pull in heavy/non-jsdom-friendly modules at import
// time. These tests don't exercise PDF code paths, so stub them.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

// Five cases. Default sort is createdAt desc, so the on-screen order is
// 26-1 (newest) → 26-5 (oldest). Doctor names alternate so a search filter
// can hide alternating rows.
const CASES = [1, 2, 3, 4, 5].map((n) => ({
  id: `case-${n}`,
  caseNumber: `26-${n}`,
  patientFirstName: "Pat",
  patientLastName: `Lastname${n}`,
  doctorName: n % 2 === 1 ? "Dr. Alpha" : "Dr. Beta",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: `2026-06-${String(30 - n).padStart(2, "0")}T10:00:00.000Z`,
  updatedAt: `2026-06-${String(30 - n).padStart(2, "0")}T10:00:00.000Z`,
  totalPrice: "0",
}));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      if (path.endsWith("/cases")) {
        return new Response(JSON.stringify(CASES), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path.endsWith("/organizations")) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  sessionStorage.clear();
});

async function renderCasesList() {
  const Wrapper = makeAuthWrapper("/cases");
  render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);
  // Wait for the rows to render.
  await screen.findByLabelText("Select case 26-1");
}

function checkbox(caseNumber: string): HTMLInputElement {
  return screen.getByLabelText(
    `Select case ${caseNumber}`,
  ) as HTMLInputElement;
}

function selectedNumbers(): string[] {
  return ["26-1", "26-2", "26-3", "26-4", "26-5"].filter(
    (n) => checkbox(n).checked,
  );
}

describe("Cases list shift-click range selection", () => {
  it("selects the range downward (anchor above the shift-clicked row)", async () => {
    await renderCasesList();

    fireEvent.click(checkbox("26-1"));
    fireEvent.click(checkbox("26-4"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["26-1", "26-2", "26-3", "26-4"]);
  });

  it("selects the range upward (anchor below the shift-clicked row)", async () => {
    await renderCasesList();

    fireEvent.click(checkbox("26-4"));
    fireEvent.click(checkbox("26-2"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["26-2", "26-3", "26-4"]);
  });

  it("adds the range to previously selected cases outside it", async () => {
    await renderCasesList();

    // Select 26-5 first, then anchor on 26-1 and shift-click 26-3.
    fireEvent.click(checkbox("26-5"));
    fireEvent.click(checkbox("26-1"));
    fireEvent.click(checkbox("26-3"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["26-1", "26-2", "26-3", "26-5"]);
  });

  it("follows the filtered order and never selects hidden cases", async () => {
    await renderCasesList();

    // Filter to Dr. Alpha's cases only (26-1, 26-3, 26-5 visible).
    fireEvent.change(
      screen.getByPlaceholderText("Search case #, doctor, patient…"),
      { target: { value: "Alpha" } },
    );
    expect(screen.queryByLabelText("Select case 26-2")).toBeNull();

    fireEvent.click(checkbox("26-1"));
    fireEvent.click(checkbox("26-5"), { shiftKey: true });
    expect(checkbox("26-3").checked).toBe(true);

    // Exactly the 3 visible cases are selected — hidden ones (26-2, 26-4)
    // were never included even though they sit between the endpoints in the
    // unfiltered order. (Clearing the filter would reset the selection, an
    // existing behavior, so assert the count while still filtered.)
    expect(screen.getByText("3 cases selected")).toBeInTheDocument();
  });

  it("falls back to a single toggle and resets the anchor when the anchor is filtered out", async () => {
    await renderCasesList();

    // Anchor on 26-2 (Dr. Beta), then filter it out of view.
    fireEvent.click(checkbox("26-2"));
    fireEvent.change(
      screen.getByPlaceholderText("Search case #, doctor, patient…"),
      { target: { value: "Alpha" } },
    );
    expect(screen.queryByLabelText("Select case 26-2")).toBeNull();

    // Shift-click with a stale anchor: only the clicked case toggles…
    fireEvent.click(checkbox("26-5"), { shiftKey: true });
    expect(checkbox("26-5").checked).toBe(true);
    expect(checkbox("26-1").checked).toBe(false);
    expect(checkbox("26-3").checked).toBe(false);

    // …and the anchor resets to the clicked case, so a follow-up
    // shift-click ranges from 26-5 within the visible list.
    fireEvent.click(checkbox("26-1"), { shiftKey: true });
    expect(checkbox("26-1").checked).toBe(true);
    expect(checkbox("26-3").checked).toBe(true);
    expect(checkbox("26-5").checked).toBe(true);
  });

  it("keeps normal single toggling and select-all behavior intact", async () => {
    await renderCasesList();

    // Single toggle on and off.
    fireEvent.click(checkbox("26-3"));
    expect(checkbox("26-3").checked).toBe(true);
    fireEvent.click(checkbox("26-3"));
    expect(checkbox("26-3").checked).toBe(false);

    // Select all / deselect all via the header checkbox.
    const selectAll = screen.getByLabelText(
      "Select all cases",
    ) as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(selectedNumbers()).toEqual([
      "26-1",
      "26-2",
      "26-3",
      "26-4",
      "26-5",
    ]);
    fireEvent.click(selectAll);
    expect(selectedNumbers()).toEqual([]);
  });
});
