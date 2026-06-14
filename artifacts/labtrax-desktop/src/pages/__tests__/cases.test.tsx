/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
