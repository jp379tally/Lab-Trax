/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CaseDrawer } from "@/pages/cases";
import type { LabCase } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";

// jspdf and react-pdf pull in heavy/non-jsdom-friendly modules at import time.
// This flow never touches PDF code, but the imports load at module time.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

function withAiPanel(children: React.ReactNode) {
  return (
    <AiPanelContext.Provider value={{ openPanel: () => {} }}>
      {children}
    </AiPanelContext.Provider>
  );
}

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

// Other cases at this lab. Their doctor names must populate the picker even
// though the parent (e.g. the dashboard) renders the drawer with no
// `doctorNames` prop — that omission used to leave the picker showing
// "No doctors found."
const labCases: LabCase[] = [
  fakeCase,
  { ...fakeCase, id: "case-2", doctorName: "Dr. SelfFetched" } as LabCase,
  { ...fakeCase, id: "case-3", doctorName: "Dr. Onfile" } as LabCase,
];

// Distinct doctor names extracted from the fake lab cases.
const fakeDoctorNames = Array.from(
  new Set(labCases.map((c) => c.doctorName).filter(Boolean)),
).sort((a, b) => a!.localeCompare(b!)) as string[];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // Dedicated doctor-names endpoint — must be checked BEFORE the generic
      // /cases pattern so it returns string[] rather than LabCase[].
      if (url.includes("/cases/doctor-names")) {
        return new Response(JSON.stringify(fakeDoctorNames), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Case detail endpoint — return the full case so edit-mode fields populate.
      if (url.includes(`/cases/${fakeCase.id}`) && !url.includes("remake")) {
        return new Response(JSON.stringify(fakeCase), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Remake-chain lookup — irrelevant here.
      if (url.includes("remake")) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.includes("/organizations") ||
        url.includes("/finance/vendors") ||
        url.includes("/presets")
      ) {
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
  vi.unstubAllGlobals();
});

describe("CaseDrawer doctor picker self-fetch", () => {
  it("populates the doctor picker from the lab's cases when no doctorNames prop is provided", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    // Rendered WITHOUT a doctorNames prop — mirrors the dashboard entry point.
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={fakeCase} onClose={() => {}} />)}
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getAllByText(/Jane/).length).toBeGreaterThan(0),
    );

    // Enter edit mode, then open the DoctorNamePicker (its toggle shows the
    // case's current doctor name while the dropdown is closed).
    fireEvent.click(await screen.findByRole("button", { name: /Edit/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Dr\. Smith/i }));

    // Self-fetched doctor names appear as options instead of "No doctors found."
    expect(
      await screen.findByRole("button", { name: /Dr\. SelfFetched/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Dr\. Onfile/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No doctors found.")).not.toBeInTheDocument();
  });
});
