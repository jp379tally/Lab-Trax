/** @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DashboardPage from "@/pages/dashboard";
import { AiPanelContext } from "@/lib/ai-panel-context";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { SessionUser } from "@/lib/api";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

vi.mock("@/components/DashboardDropZone", () => ({
  DashboardDropZone: () => null,
}));
vi.mock("@/components/UnassignedDocumentsCard", () => ({
  UnassignedDocumentsCard: () => null,
}));
vi.mock("@/components/TrialBanner", () => ({
  DashboardSubscriptionBanner: () => null,
}));

const initialCase = {
  id: "case-initial",
  caseNumber: "26-100",
  patientFirstName: "Remake",
  patientLastName: "Patient",
  doctorName: "Dr. Test",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: "2026-01-15T10:00:00.000Z",
  updatedAt: "2026-01-15T10:00:00.000Z",
  totalPrice: "0",
  labOrganizationId: "lab-1",
};

const cachedSibling = {
  ...initialCase,
  id: "case-cached",
  caseNumber: "26-101",
  patientFirstName: "Cached",
  patientLastName: "Sibling",
};

const fetchedSibling = {
  ...initialCase,
  id: "case-fetched",
  caseNumber: "26-102",
  patientFirstName: "Fetched",
  patientLastName: "Sibling",
};

const remakeChain = [
  {
    id: initialCase.id,
    caseNumber: initialCase.caseNumber,
    status: initialCase.status,
    remakeReason: null,
    remakeCharged: null,
    createdAt: initialCase.createdAt,
  },
  {
    id: cachedSibling.id,
    caseNumber: cachedSibling.caseNumber,
    status: cachedSibling.status,
    remakeReason: "Wrong shade",
    remakeCharged: true,
    createdAt: cachedSibling.createdAt,
  },
  {
    id: fetchedSibling.id,
    caseNumber: fetchedSibling.caseNumber,
    status: fetchedSibling.status,
    remakeReason: "Fit issue",
    remakeCharged: false,
    createdAt: fetchedSibling.createdAt,
  },
];

function withAiPanel(children: React.ReactNode) {
  return (
    <AiPanelContext.Provider value={{ openPanel: () => {} }}>
      {children}
    </AiPanelContext.Provider>
  );
}

function detailFor(caseValue: typeof initialCase) {
  return {
    ...caseValue,
    restorations: [],
    notes: [],
    events: [],
    attachments: [],
    remakeChildren: caseValue.id === initialCase.id ? [cachedSibling, fetchedSibling] : [],
    remakeOriginal:
      caseValue.id === initialCase.id
        ? null
        : {
            id: initialCase.id,
            caseNumber: initialCase.caseNumber,
            patientFirstName: initialCase.patientFirstName,
            patientLastName: initialCase.patientLastName,
            status: initialCase.status,
            createdAt: initialCase.createdAt,
          },
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function setupDashboardFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(new URL(url, "http://localhost").pathname);
      const path = new URL(url, "http://localhost").pathname;

      if (path.endsWith("/auth/me")) {
        return json({
          memberships: [
            {
              status: "active",
              organizationId: "lab-1",
              role: "admin",
              organization: { id: "lab-1", type: "lab", name: "Test Lab" },
            },
          ],
        });
      }
      if (path.endsWith("/case-exceptions/active")) {
        return json({
          exceptions: [
            {
              id: "exception-1",
              caseId: initialCase.id,
              caseKind: "canonical",
              caseNumber: initialCase.caseNumber,
              patientFirstName: initialCase.patientFirstName,
              patientLastName: initialCase.patientLastName,
              doctorName: initialCase.doctorName,
              issueText: "Needs remake review",
              createdAt: initialCase.createdAt,
              createdByName: "Tester",
              hasMedia: false,
              mediaCount: 0,
            },
          ],
        });
      }
      if (path.endsWith("/cases/recent")) return json([]);
      if (path.endsWith("/cases")) return json([initialCase, cachedSibling]);
      if (path.endsWith("/remake-chain")) return json({ chain: remakeChain });
      if (path.endsWith(`/cases/${initialCase.id}`)) return json(detailFor(initialCase));
      if (path.endsWith(`/cases/${cachedSibling.id}`)) return json(detailFor(cachedSibling));
      if (path.endsWith(`/cases/${fetchedSibling.id}`)) return json(detailFor(fetchedSibling));
      if (path.endsWith("/locations")) return json([]);
      if (path.endsWith("/organizations")) return json([]);
      if (path.endsWith("/doctor-names")) return json([]);
      if (path.endsWith("/invoices")) return json([]);
      if (path.endsWith("/billing/subscription")) return json({});
      return json([]);
    }),
  );
  return calls;
}

function renderDashboard() {
  const Wrapper = makeAuthWrapper("/dashboard", {
    user: { id: "admin-1", username: "admin", role: "admin" } as SessionUser,
    status: "authed",
  });
  render(<Wrapper>{withAiPanel(<DashboardPage />)}</Wrapper>);
}

describe("Dashboard exception remake navigation", () => {
  beforeEach(() => {
    setupDashboardFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a remake already in the dashboard case cache without closing the drawer", async () => {
    renderDashboard();

    fireEvent.click(await screen.findByTestId("exception-case-row-case-initial"));
    await screen.findByText("Remake history");

    const cachedGenerations = await screen.findAllByRole("button", { name: /26-101/ });
    const cachedGeneration = cachedGenerations[cachedGenerations.length - 1];
    fireEvent.click(cachedGeneration);

    await waitFor(() => {
      expect(screen.getAllByText("Cached Sibling").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("26-101").length).toBeGreaterThan(0);
    expect(await screen.findByText("Remake history")).toBeInTheDocument();
  });

  it("fetches a remake missing from the dashboard cache before replacing the drawer case", async () => {
    let releaseFetched: ((response: Response) => void) | undefined;
    const fetchedResponse = new Promise<Response>((resolve) => {
      releaseFetched = resolve;
    });

    const fetchMock = vi.mocked(globalThis.fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      if (path.endsWith(`/cases/${fetchedSibling.id}`)) {
        return fetchedResponse;
      }
      return defaultFetch ? defaultFetch(input) : json([]);
    });

    renderDashboard();

    fireEvent.click(await screen.findByTestId("exception-case-row-case-initial"));
    await screen.findByText("Remake history");
    const fetchedGenerations = await screen.findAllByRole("button", { name: /26-102/ });
    fireEvent.keyDown(fetchedGenerations[fetchedGenerations.length - 1], {
      key: "Enter",
    });

    expect(screen.getAllByText("Remake Patient").length).toBeGreaterThan(0);
    expect(screen.queryByText("Fetched Sibling")).not.toBeInTheDocument();

    releaseFetched?.(json(detailFor(fetchedSibling)));
    await waitFor(() => {
      expect(screen.getAllByText("Fetched Sibling").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("26-102").length).toBeGreaterThan(0);
  });

  it("keeps the current exception drawer usable when a missing sibling cannot load", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (new URL(url, "http://localhost").pathname.endsWith(`/cases/${fetchedSibling.id}`)) {
        return new Response(JSON.stringify({ message: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return defaultFetch ? defaultFetch(input) : json([]);
    });

    renderDashboard();

    fireEvent.click(await screen.findByTestId("exception-case-row-case-initial"));
    await screen.findByText("Remake history");
    const fetchedGenerations = await screen.findAllByRole("button", { name: /26-102/ });
    fireEvent.click(fetchedGenerations[fetchedGenerations.length - 1]);

    await waitFor(() => {
      expect(screen.getAllByText("Remake Patient").length).toBeGreaterThan(0);
      expect(screen.getByText("Remake history")).toBeInTheDocument();
    });
    expect(screen.queryByText("Fetched Sibling")).not.toBeInTheDocument();
  });
});