/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CasesPage, { CaseDrawer } from "@/pages/cases";
import type { LabCase } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";

function withAiPanel(children: React.ReactNode) {
  return (
    <AiPanelContext.Provider value={{ openPanel: () => {} }}>
      {children}
    </AiPanelContext.Provider>
  );
}

// jspdf and react-pdf pull in heavy/non-jsdom-friendly modules at import
// time. The smoke render doesn't exercise PDF code paths, so stub them.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // Return empty arrays/objects for everything the case list and drawer
      // ask for during a smoke render.
      if (url.includes("/cases/") || url.endsWith("/cases")) {
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

describe("CasesPage smoke render", () => {
  it("renders the case list shell without throwing", () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>,
    );
    // Status filter dropdown is always present; if it disappears the case
    // list page is broken.
    expect(screen.getAllByText(/Received/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Porcelain/i)).toBeInTheDocument();
  });
});

describe("CaseDrawer smoke render", () => {
  it("renders the case detail drawer for a minimal case without throwing", () => {
    const fakeCase: LabCase = {
      id: "case-1",
      caseNumber: "26-1",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      doctorName: "Dr. Smith",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: new Date("2026-01-15T10:00:00Z").toISOString(),
      updatedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
      totalPrice: "0",
    } as unknown as LabCase;

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={fakeCase} onClose={() => {}} />)}
      </Wrapper>,
    );
    // The patient name from the case is rendered into the drawer header.
    expect(screen.getAllByText(/Jane/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/26-1/).length).toBeGreaterThan(0);
  });
});

// Regression for Task #2409: editing a case's due date must keep the new date
// on screen after saving. The bug cleared the staged edit (pendingCaseEdit)
// immediately after the PATCH, so the field briefly reverted to the stale
// cached value while the refetch was still in flight. The fix retains the
// staged edit until the refetch lands. This test holds the refetch open and
// asserts the new date is shown (never the old one) during that window.
describe("CaseDrawer due-date persistence", () => {
  it("keeps the new due date on screen after saving (no revert flash)", async () => {
    const caseId = "case-1";
    const OLD = "2026-06-25"; // formatDueDate -> "Jun 25, 2026"
    const NEW = "2026-07-10"; // formatDueDate -> "Jul 10, 2026"

    const detailBody = (due: string) =>
      JSON.stringify({
        id: caseId,
        caseNumber: "26-1",
        patientFirstName: "Jane",
        patientLastName: "Doe",
        doctorName: "Dr. Smith",
        status: "received",
        priority: "normal",
        dueDate: due,
        createdAt: "2026-01-15T10:00:00.000Z",
        updatedAt: "2026-01-15T10:00:00.000Z",
        totalPrice: "0",
        restorations: [],
        notes: [],
      });

    let detailCalls = 0;
    let releaseRefetch: () => void = () => {};
    const refetchGate = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });

    const json = (body: string, status = 200) =>
      new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();

        if (path.endsWith(`/cases/${caseId}`)) {
          if (method === "PATCH") return json("{}");
          detailCalls += 1;
          if (detailCalls === 1) return json(detailBody(OLD));
          // The post-save refetch: hold it open so we can assert the staged
          // (new) value stays on screen while the refetch is in flight.
          await refetchGate;
          return json(detailBody(NEW));
        }
        if (path.endsWith("/cases")) return json("[]");
        // List-shaped endpoints the drawer queries (e.g. organizations) must
        // return an array or downstream .filter()/.map() calls throw.
        if (path.endsWith("/organizations")) return json("[]");
        return json("{}");
      }),
    );

    const fakeCase = {
      id: caseId,
      caseNumber: "26-1",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      doctorName: "Dr. Smith",
      status: "received",
      priority: "normal",
      dueDate: OLD,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
    } as unknown as LabCase;

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={fakeCase} onClose={() => {}} />)}
      </Wrapper>,
    );

    // Old date is shown before editing.
    expect(await screen.findByText("Jun 25, 2026")).toBeInTheDocument();

    // Open the edit form.
    const editBtn = (await screen.findAllByRole("button")).find(
      (b) => b.textContent?.trim() === "Edit",
    );
    expect(editBtn).toBeTruthy();
    fireEvent.click(editBtn!);

    // Change the due date.
    const dateInput = document.querySelector(
      'input[type="date"]',
    ) as HTMLInputElement | null;
    expect(dateInput).toBeTruthy();
    fireEvent.change(dateInput!, { target: { value: NEW } });

    // Stage the edit (lowercase "Save changes"), then commit (footer "Save Changes").
    fireEvent.click(screen.getByText("Save changes"));
    fireEvent.click(await screen.findByText("Save Changes"));

    // While the refetch is held open, the new value must remain on screen and
    // the old value must never flash back.
    expect(await screen.findByText("Jul 10, 2026")).toBeInTheDocument();
    expect(screen.queryByText("Jun 25, 2026")).not.toBeInTheDocument();

    // Release the refetch -> server returns the new value -> still shown.
    releaseRefetch();
    await waitFor(() => {
      expect(screen.getByText("Jul 10, 2026")).toBeInTheDocument();
    });
  });
});
