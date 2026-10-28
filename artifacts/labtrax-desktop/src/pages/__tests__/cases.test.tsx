/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import CasesPage, { CaseDrawer, NewCaseModal } from "@/pages/cases";
import type { LabCase } from "@/lib/types";
import type { SessionUser } from "@/lib/api";
import { formatDate, formatShortDate } from "@/lib/format";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";
import { printCaseLabel, printCaseOverview } from "@/lib/print";

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

// The returned-case wizard uploads a prescription through uploadMediaFile and
// runs the real print helpers; both are stubbed so the flow can be asserted.
vi.mock("@/lib/upload-media-file", () => ({
  uploadMediaFile: vi.fn(async (file: File) => ({ url: `media/${file.name}` })),
}));
vi.mock("@/lib/print", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/print")>();
  return {
    ...actual,
    printCaseCardAdvanced: vi.fn(),
    printCaseLabel: vi.fn(),
    printCaseOverview: vi.fn(),
  };
});

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
    // list page is broken. It's a multi-select trigger, so the statuses live
    // behind it — open it and assert the checkbox options render.
    const statusTrigger = screen.getByTestId("cases-status-filter");
    expect(statusTrigger).toHaveTextContent("Location: All");
    fireEvent.click(statusTrigger);
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Received/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitemcheckbox", { name: /^Porcelain$/i }),
    ).toBeInTheDocument();
    const caseRequests = vi.mocked(fetch).mock.calls.filter(([input]) =>
      String(input).includes("/cases/worklist"),
    );
    expect(caseRequests).toHaveLength(1);
    expect(String(caseRequests[0][0])).toContain("pageSize=10");
  });

  it("does not mark a legacy AI-imported case for review in the list", async () => {
    localStorage.clear();
    const legacyCase = {
      id: "legacy-ai-list-case",
      caseNumber: "26-977",
      patientFirstName: "Legacy",
      patientLastName: "Import",
      doctorName: "Dr. Synthetic051",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-09-20T16:00:00.000Z",
      updatedAt: "2026-10-06T16:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-legacy-ai",
      needsAiReview: true,
      aiImportSource: "itero",
      restorations: [],
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/cases/worklist")) {
          return json({
            rows: [legacyCase],
            total: 1,
            salesTotal: "0",
            page: 1,
            pageSize: 10,
            hasMore: false,
          });
        }
        return json([]);
      }),
    );
    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "legacy-list-admin", username: "admin", role: "admin" } as SessionUser,
      status: "authed",
    });
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    const caseNumber = await screen.findByText("26-977");
    const row = caseNumber.closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).queryByLabelText("Needs AI review")).not.toBeInTheDocument();
    expect(within(row as HTMLElement).queryByTitle(/needs review/i)).not.toBeInTheDocument();
  });

  it("keeps the selected case's saved On Hold station in the list and drawer instead of falling back to Processing", async () => {
    const caseId = "saved-on-hold-case";
    const savedStationCase = {
      id: caseId,
      caseNumber: "26-444",
      patientFirstName: "Case",
      patientLastName: "Hold",
      doctorName: "Dr. Location",
      status: "on_hold",
      labLocationId: "station-on-hold",
      labLocationName: "On Hold",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-09-20T16:00:00.000Z",
      updatedAt: "2026-10-06T16:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-location",
      restorations: [],
      notes: [],
      events: [],
      attachments: [],
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes(`/cases/${caseId}`)) return json(savedStationCase);
        if (new URL(url, "http://localhost").pathname.endsWith("/cases/worklist")) {
          return json({ rows: [savedStationCase], total: 1, page: 1, pageSize: 50, hasMore: false });
        }
        if (url.includes("/locations")) {
          // This is deliberately a different station with the same status. If
          // the client ignores labLocationName, the drawer regresses to it.
          return json([
            {
              id: "station-processing",
              code: "PROCESSING",
              name: "Processing",
              status: "on_hold",
            },
          ]);
        }
        if (url.includes("/organizations")) {
          return json([{ id: "lab-location", type: "lab", name: "Location Lab" }]);
        }
        return json([]);
      }),
    );

    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "admin-location", username: "admin", role: "admin" } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>,
    );
    fireEvent.click(screen.getByTestId("cases-status-filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /On Hold/i }));

    const row = (await screen.findByText("26-444")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("On Hold")).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByText(formatShortDate(savedStationCase.createdAt)),
    ).toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByText(formatShortDate(savedStationCase.updatedAt)),
    ).not.toBeInTheDocument();

    fireEvent.click(row as HTMLElement);
    fireEvent.click(await screen.findByRole("tab", { name: "Lab Slip" }));
    await waitFor(() => {
      const onHoldBadges = screen
        .getAllByText("On Hold")
        .filter(
          (element) =>
            element.tagName === "SPAN" &&
            element.className.includes("rounded-full"),
        );
      // One badge is the selected list row and one is the drawer header. The
      // separate Processing option remains available in the location picker,
      // but neither display surface may substitute it for the saved station.
      expect(onHoldBadges.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getAllByText(formatDate(savedStationCase.createdAt)).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(formatDate(savedStationCase.updatedAt))).not.toBeInTheDocument();
  });
});

describe("case location rendered refresh contract", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  function locationCase(id: string, caseNumber: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      caseNumber,
      patientFirstName: "Location",
      patientLastName: "Refresh",
      doctorName: "Dr. Move",
      status: "received",
      labLocationId: "station-received",
      labLocationName: "Received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-location-refresh",
      restorations: [],
      notes: [],
      events: [],
      attachments: [],
      ...overrides,
    };
  }

  it.each([
    { userType: "provider", viewerIsLabMember: false },
    { userType: "lab", viewerIsLabMember: false },
  ])("keeps a read-only header location across tabs for $userType viewers", async ({ userType, viewerIsLabMember }) => {
    const detail = locationCase("readonly-location", "26-RO", { viewerIsLabMember });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      return json(path.endsWith(`/cases/${detail.id}`) ? detail : []);
    }));
    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "read-only", username: "read-only", role: "member", userType } as SessionUser,
      status: "authed",
    });
    render(<Wrapper>{withAiPanel(<CaseDrawer labCase={detail as unknown as LabCase} onClose={() => {}} />)}</Wrapper>);
    await waitFor(() => expect(screen.queryByTestId("locate-case-select")).not.toBeInTheDocument());
    for (const tab of ["Lab Slip", "History", "Notes"]) {
      fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${tab}`) }));
      expect(screen.getAllByTestId("case-header-location")).toHaveLength(1);
      expect(within(screen.getByTestId("case-header-location")).getByText("Received")).toBeInTheDocument();
      expect(screen.queryByTestId("locate-case-submit")).not.toBeInTheDocument();
      expect(screen.queryByTestId("locate-case-select")).not.toBeInTheDocument();
    }
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("routes a same-status sibling on selection and lets users reselect after refusal", async () => {
    let detail = locationCase("same-status-location", "26-SAME");
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path.endsWith(`/cases/${detail.id}`)) {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          bodies.push(body);
          if (bodies.length === 1) return new Response(JSON.stringify({ error: "Route refused." }), {
            status: 409, headers: { "Content-Type": "application/json" },
          });
          detail = { ...detail, ...body, labLocationName: "Model Bench" };
        }
        return json(detail);
      }
      if (path.endsWith("/locations")) return json([
        { id: "station-received", code: "RECV", status: "received", name: "Received" },
        { id: "station-intake-custom", code: "INTAKE_CUSTOM", status: "received", name: "Custom Intake Bench" },
        { id: "station-model", code: "MODEL", status: "received", name: "Model Bench" },
      ]);
      return json([]);
    }));
    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "location-owner", username: "owner", role: "owner" } as SessionUser,
      status: "authed",
    });
    render(<Wrapper>{withAiPanel(<CaseDrawer labCase={detail as unknown as LabCase} onClose={() => {}} />)}</Wrapper>);
    await screen.findByRole("option", { name: "Model Bench" });
    expect(screen.getByRole("option", { name: "Custom Intake Bench" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Received (current)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Model Bench" })).not.toBeDisabled();
    const select = screen.getByTestId("locate-case-select");
    fireEvent.change(select, { target: { value: "station-model" } });
    expect(await screen.findByText("Route refused.")).toBeInTheDocument();
    expect(select).toHaveValue("");
    expect(screen.queryByText("Case located successfully.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("locate-case-submit")).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "station-model" } });
    expect(await screen.findByText("Case located successfully.")).toBeInTheDocument();
    expect(bodies).toEqual([
      { status: "received", labLocationId: "station-model" },
      { status: "received", labLocationId: "station-model" },
    ]);
    expect(await screen.findByRole("option", { name: "Model Bench (current)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Received" })).not.toBeDisabled();
  });

  it("keeps one header locator across tabs and edits while confirming a single move", async () => {
    const caseId = "single-location-refresh";
    const initial = locationCase(caseId, "26-501");
    const refreshed = locationCase(caseId, "26-501", {
      status: "in_design",
      labLocationId: "station-design",
      labLocationName: "Design Bench",
      events: [{
        id: "move-event-single",
        eventType: "status_changed",
        occurredAt: "2026-01-15T11:00:00.000Z",
        createdAt: "2026-01-15T11:00:00.000Z",
        metadataJson: { fromStatus: "received", toStatus: "in_design" },
      }],
    });
    let moved = false;
    let releaseDetailRefetch!: () => void;
    const detailRefetchGate = new Promise<void>((resolve) => {
      releaseDetailRefetch = resolve;
    });
    const patchBodies: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (path.endsWith(`/cases/${caseId}`) && method === "PATCH") {
          patchBodies.push(JSON.parse(String(init?.body)));
          moved = true;
          return json(refreshed);
        }
        if (path.endsWith(`/cases/${caseId}`)) {
          if (moved) await detailRefetchGate;
          return json(moved ? refreshed : initial);
        }
        if (path.endsWith("/locations")) {
          return json([
            { id: "station-received", code: "RECV", status: "received", name: "Received" },
            { id: "station-design", code: "DESIGN", status: "in_design", name: "Design Bench" },
          ]);
        }
        if (path.endsWith("/organizations")) return json([]);
        return json([]);
      }),
    );

    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "owner-location", username: "owner", role: "owner" } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(
          <CaseDrawer labCase={initial as unknown as LabCase} onClose={() => {}} />,
        )}
      </Wrapper>,
    );

    const select = await screen.findByTestId("locate-case-select");
    const location = screen.getByTestId("case-header-location");
    expect(screen.getAllByTestId("locate-case-select")).toHaveLength(1);
    expect(screen.queryByTestId("locate-case-submit")).not.toBeInTheDocument();
    expect(location.closest("header")).toContainElement(screen.getByTestId("case-header-patient"));
    expect(location.closest("header")?.nextElementSibling).not.toBe(location);
    expect(screen.queryByTestId("case-details-location")).not.toBeInTheDocument();
    expect(location).toContainElement(select);
    await screen.findByRole("option", { name: "Design Bench" });
    expect(screen.getByRole("option", { name: "Received (current)" })).toBeDisabled();
    fireEvent.change(select, { target: { value: "station-design" } });
    // A repeated selection while the write and authoritative refresh are still
    // pending must not enqueue a second PATCH.
    fireEvent.change(select, { target: { value: "station-design" } });
    for (const tab of ["History", "Notes", "Lab Slip"]) {
      fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${tab}`) }));
      expect(screen.getAllByTestId("locate-case-select")).toHaveLength(1);
      expect(screen.getByTestId("locate-case-select")).toBe(select);
      expect(select).toHaveValue("station-design");
    }
    fireEvent.click(screen.getByTestId("case-details-edit"));
    expect(screen.getAllByTestId("locate-case-select")).toHaveLength(1);
    expect(screen.getByTestId("locate-case-select")).toBe(select);
    expect(select).toHaveValue("station-design");
    expect(screen.getByPlaceholderText("Patient first name")).toBeInTheDocument();

    await waitFor(() => {
      expect(patchBodies).toEqual([
        { status: "in_design", labLocationId: "station-design" },
      ]);
    });
    expect(screen.queryByText("Case located successfully.")).not.toBeInTheDocument();

    releaseDetailRefetch();

    expect(await screen.findByText("Case located successfully.")).toBeInTheDocument();
    expect(
      await screen.findByRole("option", { name: "Design Bench (current)" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /History/i }));
    expect(screen.getAllByTestId("locate-case-select")).toHaveLength(1);
    expect(await screen.findByText("Location Changed")).toBeInTheDocument();
  }, 20000);

  it("refetches every affected open detail and waits for both before confirming a bulk move", async () => {
    const first = locationCase("bulk-location-a", "26-601");
    const second = locationCase("bulk-location-b", "26-602");
    const rows = [first, second];
    let moved = false;
    const refreshedIds: string[] = [];
    const releaseById = new Map<string, () => void>();
    const gates = new Map(
      rows.map((row) => [
        row.id,
        new Promise<void>((resolve) => releaseById.set(row.id, resolve)),
      ]),
    );
    const postBodies: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        const path = url.pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (path.endsWith("/cases/bulk-status") && method === "POST") {
          postBodies.push(JSON.parse(String(init?.body)));
          moved = true;
          return json({ updatedCount: 2 });
        }
        const detailRow = rows.find((row) => path.endsWith(`/cases/${row.id}`));
        if (detailRow) {
          if (moved) {
            refreshedIds.push(detailRow.id);
            await gates.get(detailRow.id);
          }
          return json(
            moved
              ? locationCase(detailRow.id, detailRow.caseNumber, {
                  status: "in_design",
                  labLocationId: "station-design-custom",
                  labLocationName: "Custom Design Bench",
                })
              : detailRow,
          );
        }
        if (path.endsWith("/cases/worklist")) {
          return json({ rows, total: 2, page: 1, pageSize: 50, hasMore: false });
        }
        if (path.endsWith("/locations")) {
          return json([
            { id: "station-received", code: "RECV", status: "received", name: "Received" },
            { id: "station-design", code: "DESIGN", status: "in_design", name: "Design Bench" },
            { id: "station-design-custom", code: "DESIGN_CUSTOM", status: "in_design", name: "Custom Design Bench" },
          ]);
        }
        if (path.endsWith("/organizations")) {
          return json([{ id: "lab-location-refresh", type: "lab", name: "Location Lab" }]);
        }
        return json([]);
      }),
    );

    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "owner-location", username: "owner", role: "owner" } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(
          <>
            <CasesPage />
            <CaseDrawer labCase={first as unknown as LabCase} onClose={() => {}} />
            <CaseDrawer labCase={second as unknown as LabCase} onClose={() => {}} />
          </>,
        )}
      </Wrapper>,
    );

    fireEvent.click(screen.getByTestId("cases-status-filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Received$/i }));
    await screen.findByRole("checkbox", { name: "Select case 26-601" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select case 26-601" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select case 26-602" }));
    fireEvent.click(screen.getByRole("button", { name: "Change Location" }));
    fireEvent.change(screen.getByLabelText("New location"), {
      target: { value: "station-design-custom" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(postBodies).toEqual([{
        caseIds: ["bulk-location-a", "bulk-location-b"],
        status: "in_design",
        labLocationId: "station-design-custom",
      }]);
      expect(new Set(refreshedIds)).toEqual(
        new Set(["bulk-location-a", "bulk-location-b"]),
      );
    });
    expect(screen.queryByText("2 cases marked as Custom Design Bench.")).not.toBeInTheDocument();

    releaseById.get("bulk-location-a")?.();
    await Promise.resolve();
    expect(screen.queryByText("2 cases marked as Custom Design Bench.")).not.toBeInTheDocument();

    releaseById.get("bulk-location-b")?.();
    expect(await screen.findByText("2 cases marked as Custom Design Bench.")).toBeInTheDocument();
  }, 20000);
});

describe("CaseDrawer smoke render", () => {
  it("renders the case detail drawer for a minimal case without throwing", () => {
    const fakeCase: LabCase = {
      id: "case-1",
      caseNumber: "26-1",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      doctorName: "Dr. Synthetic063",
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
    // Dashboard and other standalone entry points retain their Lab Slip default.
    expect(screen.getByTestId("case-details-edit")).toBeInTheDocument();
    expect(screen.queryByText("Case History")).not.toBeInTheDocument();
  });

  it("ignores the legacy review flag while keeping independent correction notices and practice editing", async () => {
    const caseId = "legacy-ai-detail-case";
    const detail = {
      id: caseId,
      caseNumber: "26-978",
      patientFirstName: "Legacy",
      patientLastName: "Detail",
      doctorName: "Dr. Extracted",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-09-20T16:00:00.000Z",
      updatedAt: "2026-10-06T16:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-legacy-ai",
      providerOrganizationId: "practice-legacy-ai",
      needsAiReview: true,
      aiImportSource: "itero",
      suggestedDoctorName: "Dr. Existing",
      suggestedPracticeName: "Example Practice",
      unrecognizedMaterials: ["Unmapped Ceramic"],
      restorations: [],
      notes: [],
      events: [],
      attachments: [],
      viewerIsLabMember: true,
      viewerCanManageAttachments: true,
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path.endsWith(`/cases/${caseId}`)) return json(detail);
      if (path.endsWith("/organizations")) {
        return json([
          {
            id: "practice-legacy-ai",
            type: "provider",
            name: "Example Practice",
            displayName: "Example Practice",
          },
        ]);
      }
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "legacy-detail-admin", username: "admin", role: "admin" } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(
          <CaseDrawer labCase={detail as unknown as LabCase} onClose={() => {}} />,
        )}
      </Wrapper>,
    );

    expect(await screen.findByText(/Unrecognized material:/)).toHaveTextContent("Unmapped Ceramic");
    expect(screen.getByText(/Did you mean/)).toHaveTextContent("Dr. Existing");
    expect(screen.getByRole("button", { name: "Use this doctor" })).toBeInTheDocument();
    expect(screen.queryByText("AI-imported — needs review")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark as reviewed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check duplicates" })).not.toBeInTheDocument();
    expect(screen.getByTestId("case-remake-create")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/cases/patient-similarity"),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByTestId("case-details-edit"));
    expect(await screen.findByText("Practice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Example Practice/ })).toBeInTheDocument();
  });

  it("creates a linked remake from a legacy iTero case without opening review or duplicate checks", async () => {
    const caseId = "legacy-ai-remake-case";
    const remakeId = "legacy-ai-remake-created";
    const detail = {
      id: caseId,
      caseNumber: "26-979",
      patientFirstName: "Legacy",
      patientLastName: "Remake",
      doctorName: "Dr. Imported",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-09-20T16:00:00.000Z",
      updatedAt: "2026-10-06T16:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-legacy-ai",
      providerOrganizationId: "practice-legacy-ai",
      needsAiReview: true,
      aiImportSource: "itero",
      restorations: [],
      notes: [],
      events: [],
      attachments: [],
      viewerIsLabMember: true,
      viewerCanManageAttachments: true,
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const remakeRequests: Array<{ path: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === `/api/cases/${caseId}`) return json(detail);
      if (path === `/api/cases/${caseId}/remake`) {
        remakeRequests.push({ path, init });
        return json({ data: { id: remakeId, caseNumber: "26-979B" } });
      }
      if (path.endsWith("/organizations")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "legacy-remake-admin", username: "admin", role: "admin" } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(
          <CaseDrawer labCase={detail as unknown as LabCase} onClose={() => {}} />,
        )}
      </Wrapper>,
    );

    expect(screen.queryByText("AI-imported — needs review")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark as reviewed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check duplicates" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("case-remake-create"));
    expect(await screen.findByText("Create Remake — #26-979")).toBeInTheDocument();
    const remakeReasonOption = screen.getByRole("option", {
      name: "Didn't fit — margins",
    });
    fireEvent.change(remakeReasonOption.closest("select") as HTMLSelectElement, {
      target: { value: "fit_margins" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Yes — invoice as usual" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Remake" }));

    await waitFor(() => {
      expect(remakeRequests).toHaveLength(1);
      expect(remakeRequests[0]?.path).toBe(`/api/cases/${caseId}/remake`);
      expect(remakeRequests[0]?.init?.method).toBe("POST");
      expect(JSON.parse(String(remakeRequests[0]?.init?.body))).toMatchObject({
        remakeReasonKey: "fit_margins",
        remakeReason: "Didn't fit — margins",
        remakeCharged: true,
      });
    });
    expect(screen.queryByText("Create Remake — #26-979")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark as reviewed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check duplicates" })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/cases/patient-similarity"),
      ),
    ).toBe(false);
  });

  it("shows all file groups collapsed, then expands sections independently and globally", async () => {
    localStorage.clear();
    const caseId = "grouped-files-case";
    const detail = {
      id: caseId,
      caseNumber: "26-4319",
      patientFirstName: "File",
      patientLastName: "Sections",
      doctorName: "Dr. Group",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-files",
      restorations: [],
      notes: [],
      events: [],
      viewerCanManageAttachments: true,
      attachments: [
        { id: "photo", caseId, fileName: "photo.jpg", fileType: "image/jpeg", storageKey: "photo" },
        { id: "rx", caseId, fileName: "rx.jpg", fileType: "image/jpeg", category: "prescription", storageKey: "rx" },
        { id: "scan", caseId, fileName: "scan.PLY", fileType: "application/octet-stream", storageKey: "scan" },
      ],
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/cases/${caseId}`)) return json(detail);
        return json([]);
      }),
    );
    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "files-user", username: "files", role: "admin" } as SessionUser,
      status: "authed",
    });
    const view = render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={detail as unknown as LabCase} onClose={() => {}} />)}
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Files/ }));

    const media = await screen.findByRole("button", { name: /Images\/videos/ });
    const documents = screen.getByRole("button", { name: /Documents/ });
    const files = screen.getByRole("button", { name: /^Files\(/ });
    expect(media).toHaveTextContent("Images/videos");
    expect(media).toHaveTextContent("(1)");
    expect(documents).toHaveTextContent("(1)");
    expect(files).toHaveTextContent("(1)");
    expect(screen.getByTestId("attachment-section-media")).toHaveClass("border-section");
    expect(screen.getByTestId("attachment-section-documents")).toHaveClass("border-section");
    expect(media).toHaveAttribute("aria-expanded", "false");
    expect(documents).toHaveAttribute("aria-expanded", "false");
    expect(files).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("photo.jpg")).not.toBeInTheDocument();

    fireEvent.click(documents);
    expect(documents).toHaveAttribute("aria-expanded", "true");
    expect(
      screen
        .getByTestId("attachment-section-documents")
        .querySelector(".border-t.border-section"),
    ).toBeInTheDocument();
    expect(await screen.findByText("rx.jpg")).toBeInTheDocument();
    expect(screen.queryByText("photo.jpg")).not.toBeInTheDocument();
    expect(
      localStorage.getItem("labtrax.desktop.case-files.sections.v1:files-user"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Save all section preferences" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(media).toHaveAttribute("aria-expanded", "true");
    expect(files).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("photo.jpg")).toBeInTheDocument();
    expect(await screen.findByText("scan.PLY")).toBeInTheDocument();

    const stored = localStorage.getItem(
      "labtrax.desktop.case-files.sections.v1:files-user",
    );
    expect(stored).toContain('"media":true');
    view.unmount();
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={detail as unknown as LabCase} onClose={() => {}} />)}
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Files/ }));
    expect(
      await screen.findByRole("button", { name: /Images\/videos/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Files\(/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("keeps Remake and Exception case beside the header patient name", async () => {
    const caseId = "patient-actions-case";
    const detail = {
      id: caseId,
      caseNumber: "26-42",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      doctorName: "Dr. Synthetic063",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-1",
      viewerCanManageAttachments: true,
      viewerIsLabMember: true,
      restorations: [],
      notes: [],
      events: [],
      attachments: [],
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes(`/cases/${caseId}`)) return json(detail);
        if (url.includes("/locations")) return json([]);
        if (url.includes("/organizations")) return json([]);
        return json([]);
      }),
    );

    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "admin-1", username: "admin", role: "admin" } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(
          <CaseDrawer
            labCase={detail as unknown as LabCase}
            onClose={() => {}}
          />,
        )}
      </Wrapper>,
    );

    const remakeButton = await screen.findByTestId("case-remake-create");
    const exceptionButton = screen.getByTestId("case-exception-create");
    const actionGroup = screen.getByTestId("case-header-actions");
    expect(actionGroup).toContainElement(remakeButton);
    expect(actionGroup).toContainElement(exceptionButton);
    expect(within(actionGroup).getAllByRole("button")).toEqual([remakeButton, exceptionButton]);
    // "Jane Doe" appears twice: once in the header, once in the Case Details
    // "Patient" field below — the header instance renders first in the DOM.
    const headerNameRow = screen.getAllByText("Jane Doe")[0]
      .parentElement as HTMLElement;
    const patientSection = screen.getByTestId("case-slip-patient-provider");
    const patientDetailLabel = within(patientSection).getByText("Patient", {
      exact: true,
    });
    const patientDetailRow = patientDetailLabel.nextElementSibling as HTMLElement;
    // Remake and exception creation now live in the header, beside the patient name.
    expect(headerNameRow).toContainElement(remakeButton);
    expect(headerNameRow).toContainElement(exceptionButton);
    expect(
      Array.from(headerNameRow.querySelectorAll("button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Remake", "Create Exception Case"]);
    expect(screen.getAllByTitle("Create a remake of this case")).toHaveLength(1);
    expect(patientDetailRow).not.toContainElement(remakeButton);
    expect(patientDetailRow).not.toContainElement(exceptionButton);
    expect(
      Array.from(patientDetailRow.querySelectorAll("button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Preview Rx"]);

    const sharedClasses = [
      "h-8",
      "min-w-32",
      "border",
      "border-primary",
      "bg-primary",
      "text-primary-foreground",
    ];
    expect(remakeButton).toHaveClass(...sharedClasses);
    expect(exceptionButton).toHaveClass(...sharedClasses);

    fireEvent.click(remakeButton);
    expect(
      await screen.findByText("Create Remake — #26-42"),
    ).toBeInTheDocument();
  });
});

describe("CaseDrawer lab slip dated notes", () => {
  // Note timestamps are genuine instants, so the day shown is the local day the
  // note was entered. Fixtures are built with the local-time Date constructor
  // and serialized via toISOString() so assertions hold in any host timezone.
  const localIso = (year: number, monthIndex: number, day: number) =>
    new Date(year, monthIndex, day, 12, 0, 0, 0).toISOString();

  function renderLabSlip(
    notes: unknown[],
    overrides: Record<string, unknown> = {},
  ) {
    const caseId =
      typeof overrides.id === "string" ? overrides.id : "dated-notes-case";
    const detail = {
      id: caseId,
      caseNumber: "26-99",
      patientFirstName: "Dated",
      patientLastName: "Notes",
      doctorName: "Dr. Byrne",
      status: "received",
      priority: "normal",
      dueDate: null,
      receivedAt: localIso(2026, 8, 16),
      caseNotes: "Use the prescribed lingual contour.",
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-1",
      viewerIsLabMember: true,
      restorations: [],
      events: [],
      attachments: [],
      notes,
      ...overrides,
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes(`/cases/${caseId}`)) return json(detail);
        return json([]);
      }),
    );
    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "admin-1", username: "admin", role: "admin" } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(
          <CaseDrawer labCase={detail as unknown as LabCase} onClose={() => {}} />,
        )}
      </Wrapper>,
    );
  }

  it("shows AI/restoration teeth as read-only text without shade controls", async () => {
    renderLabSlip([], {
      id: "ai-tooth-display-case",
      restorations: [
        {
          id: "rest-tooth-range",
          toothNumber: "14-16",
          restorationType: "Crown",
          material: "Zirconia",
          shade: "B1",
          quantity: 1,
        },
        {
          id: "rest-tooth-single",
          toothNumber: "3",
          restorationType: "Crown",
          material: "Zirconia",
          shade: "A2",
          quantity: 1,
        },
      ],
    });

    const toothDisplay = await screen.findByTestId("case-tooth-display");
    expect(within(toothDisplay).getByText("Tooth", { exact: true })).toBeInTheDocument();
    expect(toothDisplay).toHaveTextContent("14-16, 3");
    expect(within(toothDisplay).queryByText("B1")).not.toBeInTheDocument();
    expect(within(toothDisplay).queryByText("A2")).not.toBeInTheDocument();
    expect(within(toothDisplay).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(toothDisplay).queryByRole("button")).not.toBeInTheDocument();
    expect(within(toothDisplay).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Tooth / Shade")).not.toBeInTheDocument();
  });

  it("uses legacy case teeth when there are no restoration values and stays neutral when empty", async () => {
    renderLabSlip([], {
      id: "legacy-tooth-display-case",
      teeth: "12-14, 21",
      restorations: [],
    });
    expect(await screen.findByTestId("case-tooth-display")).toHaveTextContent("12-14, 21");
  });

  it("shows a neutral tooth value when restoration and case-level data are empty", async () => {
    renderLabSlip([], {
      id: "empty-tooth-display-case",
      restorations: [
        {
          id: "empty-tooth-row",
          toothNumber: "",
          restorationType: "Full Denture",
          material: "Acrylic",
          shade: "A2",
          arch: "upper",
          quantity: 1,
        },
      ],
    });
    const toothDisplay = await screen.findByTestId("case-tooth-display");
    expect(toothDisplay).toHaveTextContent("Tooth—");
    expect(within(toothDisplay).queryByText("Full arch (upper & lower)")).not.toBeInTheDocument();
    expect(within(toothDisplay).queryByText("A2")).not.toBeInTheDocument();
  });

  it("shows manually saved tooth numbers after the Case Details editor saves and refetches", async () => {
    const caseId = "manual-tooth-edit-case";
    const detail: Record<string, any> = {
      id: caseId,
      caseNumber: "26-88",
      patientFirstName: "Manual",
      patientLastName: "Teeth",
      doctorName: "Dr. Byrne",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-1",
      viewerIsLabMember: true,
      restorations: [],
      notes: [],
      events: [],
      attachments: [],
    };
    const hierarchyBodies: unknown[] = [];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.pathname.endsWith(`/cases/${caseId}/restorations/hierarchy`) && method === "PATCH") {
          const body = JSON.parse(String(init?.body));
          hierarchyBodies.push(body);
          detail.restorations = body.toothNumbers.map((toothNumber: string, index: number) => ({
            id: `manual-restoration-${index}`,
            caseId,
            toothNumber,
            restorationType: body.restorationType,
            material: body.material,
            shade: null,
            quantity: 1,
          }));
          return json({
            updatedCount: 0,
            createdCount: detail.restorations.length,
            deletedCount: 0,
            repricedCount: 0,
            manualPriceCount: 0,
            unpricedCount: 0,
            invoiceAction: "skipped",
          });
        }
        if (url.pathname.endsWith(`/cases/${caseId}`)) return json(detail);
        return json([]);
      }),
    );
    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "manual-tooth-admin", username: "admin", role: "admin" } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={detail as unknown as LabCase} onClose={() => {}} />)}
      </Wrapper>,
    );

    fireEvent.click(await screen.findByTestId("case-details-edit"));
    fireEvent.change(await screen.findByRole("textbox", { name: "Tooth Numbers" }), {
      target: { value: "7, 8" },
    });
    fireEvent.click(screen.getByTestId("case-details-edit-save"));

    await waitFor(() => {
      expect(hierarchyBodies).toEqual([
        expect.objectContaining({ toothNumbers: ["7", "8"] }),
      ]);
    });
    expect(await screen.findByTestId("case-tooth-display")).toHaveTextContent("7, 8");
    expect(screen.queryByRole("textbox", { name: "Tooth Numbers" })).not.toBeInTheDocument();
  });

  it("keeps an existing exception beside Remake, and preserves the shared location in edit mode", async () => {
    renderLabSlip([], { viewerCanManageAttachments: true, activeException: { id: "existing-exception" } });
    const existing = await screen.findByTestId("case-exception-open");
    const group = screen.getByTestId("case-header-actions");
    expect(within(group).getAllByRole("button")).toEqual([
      screen.getByTestId("case-remake-create"),
      existing,
    ]);
    expect(screen.queryByTestId("case-exception-create")).not.toBeInTheDocument();
    const location = screen.getByTestId("case-header-location");
    fireEvent.click(screen.getByTestId("case-details-edit"));
    expect(screen.getByTestId("case-header-location")).toBe(location);
    expect(screen.getAllByTestId("locate-case-select")).toHaveLength(1);
  });

  it("keeps one prescription section on the Lab Slip and leaves authored notes to the Notes tab", async () => {
    renderLabSlip([
      {
        id: "note-old",
        noteText: "Model poured",
        visibility: "internal_lab_only",
        authorName: "Robin Tech",
        createdAt: localIso(2026, 0, 5),
      },
      {
        id: "note-new",
        noteText: "Confirmed with Dr. Byrne that we are going to TIW.",
        visibility: "shared_with_provider",
        authorName: "Casey Lab",
        createdAt: localIso(2026, 8, 15),
      },
      {
        id: "note-undated",
        noteText: "Legacy note",
        visibility: "shared_with_provider",
        authorName: "Older System",
        createdAt: null,
      },
    ]);

    // One prescription section, backed by the case's Rx text.
    expect(await screen.findByText("Rx Notes")).toBeInTheDocument();
    expect(
      screen.getByText("Use the prescribed lingual contour."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Prescription Notes")).not.toBeInTheDocument();
    // The Case Details note preview and the duplicated Lab Slip notes list are
    // both gone — authored notes are not repeated on the slip.
    expect(
      screen.queryByText(
        "09/15 Confirmed with Dr. Byrne that we are going to TIW.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("01/05 Model poured")).not.toBeInTheDocument();
    expect(screen.queryByText("Model poured")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy note")).not.toBeInTheDocument();
    expect(screen.queryByText("Lab only")).not.toBeInTheDocument();
    expect(screen.queryByText("Shared")).not.toBeInTheDocument();

    const caseDetailsTitle = screen.getByRole("heading", {
      name: "Case Details",
    });
    expect(caseDetailsTitle).toHaveClass("text-lg", "font-bold");
    const headingRow = caseDetailsTitle.parentElement as HTMLElement;
    const metadataRow = headingRow.nextElementSibling as HTMLElement;
    const dateCreated = screen.getByText(/Date Created:/);
    const dueDate = screen.getByText(/Due Date:/);
    expect(screen.getByTestId("case-details-date-created")).toContainElement(dateCreated);
    expect(screen.getByTestId("case-details-due-date")).toContainElement(dueDate);
    expect(screen.getByTestId("case-details-due-date")).toHaveClass("text-2xl");
    expect(
      within(screen.getByTestId("case-details-due-date")).getByRole("button", {
        name: "Change due date",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("case-details-metadata")).toContainElement(
      screen.getByTestId("case-details-priority"),
    );
    expect(metadataRow).toContainElement(dateCreated);
    expect(metadataRow).toContainElement(dueDate);
    const dates = within(metadataRow).getByTestId("case-details-dates");
    expect(dates).toHaveClass("flex-col", "items-start");
    expect(Array.from(dates.children)).toEqual([
      screen.getByTestId("case-details-date-created"),
      screen.getByTestId("case-details-due-date"),
    ]);
    expect(within(metadataRow).getAllByText(/Due Date:/)).toHaveLength(1);
    expect(metadataRow.nextElementSibling).toHaveClass("border-t", "border-border");
    const dividers = within(metadataRow).getAllByTestId("case-details-metadata-divider");
    expect(dividers).toHaveLength(1);
    expect(dates.nextElementSibling).toBe(dividers[0]);
    expect(dividers[0].nextElementSibling).toBe(screen.getByTestId("case-details-priority"));
    dividers.forEach((divider) => {
      expect(divider).toHaveAttribute("aria-hidden", "true");
      expect(divider).toHaveClass("w-px", "h-4", "bg-border");
    });
    expect(screen.getByText("01/15/2026")).toBeInTheDocument();
    expect(screen.getByText("Standard")).toBeInTheDocument();
    const priorityGroup = screen.getByText("Standard").parentElement
      ?.parentElement as HTMLElement;
    expect(
      within(priorityGroup).getByRole("button", { name: /Mark rush/i }),
    ).toBeInTheDocument();
    expect(
      within(headingRow).getByRole("button", { name: "Layout" }),
    ).toBeInTheDocument();
    expect(
      within(headingRow).getByRole("button", { name: "Print" }),
    ).toBeInTheDocument();
    expect(
      within(headingRow).getByRole("button", { name: "Edit" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("case-details-actions")).toContainElement(
      screen.getByTestId("case-details-layout"),
    );
    expect(screen.getByTestId("case-details-actions")).toContainElement(
      screen.getByTestId("case-details-print"),
    );
    expect(screen.getByTestId("case-details-actions")).toContainElement(
      screen.getByTestId("case-details-edit"),
    );
    expect(screen.getByTestId("case-details-rush-toggle")).toBeEnabled();
    const patientProvider = screen.getByTestId("case-slip-patient-provider");
    expect(patientProvider).toHaveClass("rounded-lg", "border");
    expect(within(patientProvider).getByRole("heading", { name: "Patient & Provider" })).toBeInTheDocument();
    expect(patientProvider.querySelector(".grid")).toHaveClass(
      "grid-cols-1",
      "@[420px]/drawer:grid-cols-2",
      "@[620px]/drawer:grid-cols-3",
    );
    expect(screen.getByTestId("case-slip-restoration-details")).toHaveClass("rounded-lg", "border");
    for (const label of ["Patient", "Doctor", "Practice"]) {
      expect(within(patientProvider).getByText(label)).toHaveClass(
        "text-xs",
        "uppercase",
        "tracking-wide",
      );
    }
    expect(screen.getByText("Received Date")).toBeInTheDocument();
    expect(screen.getByText("09/16/2026")).toBeInTheDocument();
    expect(screen.getByText("Case Type")).toBeInTheDocument();
    expect(screen.getByText("Case Subtype")).toBeInTheDocument();
    expect(screen.getByText("Case Material")).toBeInTheDocument();
    expect(screen.queryByText("Material", { exact: true })).toBeNull();

    // Every authored note — text, author and visibility — stays on the Notes
    // tab, untouched by the Lab Slip cleanup.
    fireEvent.click(screen.getByRole("tab", { name: /^Notes/ }));
    expect(
      await screen.findByText(
        "Confirmed with Dr. Byrne that we are going to TIW.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Model poured")).toBeInTheDocument();
    expect(screen.getByText("Legacy note")).toBeInTheDocument();
    expect(screen.getByText("Casey Lab")).toBeInTheDocument();
    expect(screen.getByText("Robin Tech")).toBeInTheDocument();
    expect(screen.getByText("Lab only")).toBeInTheDocument();
    expect(screen.getAllByText("Shared")).toHaveLength(2);
  });

  it("keeps Custom Shade beside the read-only tooth value and hides its details until selected", () => {
    renderLabSlip([], {
      id: "custom-shade-off-case",
      isCustomShade: false,
    });

    const customShade = screen.getByRole("checkbox", { name: "Custom Shade" });
    const pairing = screen.getByTestId("tooth-custom-shade");
    expect(customShade).not.toBeChecked();
    expect(pairing).toContainElement(customShade);
    expect(pairing).toContainElement(screen.getByTestId("case-tooth-display"));
    expect(screen.getByText("Tooth", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Tooth / Shade")).not.toBeInTheDocument();
    expect(screen.queryByText("Tooth #")).not.toBeInTheDocument();
    expect(screen.queryByText("Shade", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Technician name")).not.toBeInTheDocument();
    expect(screen.queryByText("Pictures available")).not.toBeInTheDocument();
    expect(screen.queryByText("Video available")).not.toBeInTheDocument();
  });

  it("shows the Custom Shade details when the checkbox is selected", async () => {
    renderLabSlip([], {
      id: "custom-shade-on-case",
      isCustomShade: true,
      customShadeTechnician: "Morgan Lee",
      customShadePicturesAvailable: true,
      customShadeVideoAvailable: false,
    });

    const technicianInput = await screen.findByDisplayValue("Morgan Lee");
    expect(technicianInput).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Custom Shade" }),
    ).toBeChecked();
    expect(screen.getByText("Pictures available")).toBeInTheDocument();
    expect(screen.getByText("Video available")).toBeInTheDocument();
  });

  it("shows no truncated note preview on the Lab Slip, only the full note on the Notes tab", async () => {
    const longText = "A".repeat(200);
    renderLabSlip([
      {
        id: "note-long",
        noteText: longText,
        visibility: "shared_with_provider",
        authorName: "Casey Lab",
        createdAt: localIso(2026, 8, 15),
      },
    ]);

    // The truncated, dated preview used to sit in Case Details. It is gone
    // together with the duplicated notes list.
    expect(await screen.findByText("Rx Notes")).toBeInTheDocument();
    expect(
      screen.queryByText(`09/15 ${"A".repeat(120)}…`),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(`09/15 ${longText}`)).not.toBeInTheDocument();
    expect(screen.queryByText(longText)).not.toBeInTheDocument();

    // The note itself is untouched and still readable in full on its own tab.
    fireEvent.click(screen.getByRole("tab", { name: /^Notes/ }));
    expect(await screen.findByText(longText)).toBeInTheDocument();
  });
});

describe("CaseDrawer timeline provider note", () => {
  it("shows the provider note callout on a file_assigned_from_inbox event, but not when the note is absent", async () => {
    const caseId = "inbox-note-case";
    const detail = {
      id: caseId,
      caseNumber: "26-77",
      patientFirstName: "Sam",
      patientLastName: "Rivera",
      doctorName: "Dr. Lee",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-1",
      restorations: [],
      notes: [],
      attachments: [],
      events: [
        {
          id: "evt-with-note",
          eventType: "file_assigned_from_inbox",
          occurredAt: "2026-01-15T11:00:00.000Z",
          createdAt: "2026-01-15T11:00:00.000Z",
          metadataJson: {
            attachmentId: "att-1",
            fileName: "rx.pdf",
            fileType: "application/pdf",
            description: "Dr. Lee added rx.pdf to this case.",
            providerNote: "Please rush this one, patient travels next week.",
          },
        },
        {
          id: "evt-without-note",
          eventType: "file_assigned_from_inbox",
          occurredAt: "2026-01-15T09:00:00.000Z",
          createdAt: "2026-01-15T09:00:00.000Z",
          metadataJson: {
            attachmentId: "att-2",
            fileName: "photo.jpg",
            fileType: "image/jpeg",
            description: "Dr. Lee added photo.jpg to this case.",
          },
        },
      ],
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes(`/cases/${caseId}`)) return json(detail);
        if (url.includes("/locations")) return json([]);
        if (url.includes("/organizations")) return json([]);
        return json([]);
      }),
    );

    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "admin-1", username: "admin", role: "admin" } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(
          <CaseDrawer
            labCase={detail as unknown as LabCase}
            onClose={() => {}}
          />,
        )}
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole("tab", { name: /History/i }));

    expect(
      await screen.findByText("Please rush this one, patient travels next week."),
    ).toBeInTheDocument();
    expect(screen.getByText("Provider note")).toBeInTheDocument();

    // The event without a provider note must not render the callout label.
    expect(screen.getAllByText("Provider note")).toHaveLength(1);
  });
});

// The returned-case wizard walks the user through the questions that matter
// when a complete case is located back to an intake station: due date,
// prescription, remake, removable step, notes, and the two reprints. Panels are
// driven with direct events (this suite has no user-event/PointerEvent).
describe("CaseDrawer returned-case wizard", () => {
  const caseId = "return-removable-case";

  function caseDetail(overrides: Record<string, unknown> = {}) {
    return {
      id: caseId,
      caseNumber: "26-99",
      patientFirstName: "Rita",
      patientLastName: "Return",
      doctorName: "Dr. Synthetic063",
      status: "complete",
      priority: "normal",
      dueDate: null,
      step: "wax_setup",
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "lab-1",
      viewerCanUploadAttachments: true,
      viewerCanPostNotes: true,
      restorations: [
        {
          id: "rest-return",
          toothNumber: "",
          restorationType: "denture",
          material: "Acrylic",
          quantity: 1,
        },
      ],
      notes: [],
      events: [],
      attachments: [],
      ...overrides,
    };
  }

  function renderReturnCase(
    options: {
      role?: "admin" | "owner" | "staff";
      detail?: Record<string, unknown>;
    } = {},
  ) {
    const { role = "owner", detail: detailOverrides = {} } = options;
    const requests: { method: string; path: string; body: any }[] = [];
    const detail = caseDetail(detailOverrides);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (method !== "GET") {
          requests.push({
            method,
            path,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
        }
        if (path.endsWith(`/cases/${caseId}/attachments`)) return json({ id: "att-1" });
        if (path.endsWith(`/cases/${caseId}/notes`)) return json({ id: "note-1" });
        if (path.endsWith(`/cases/${caseId}`)) return json(detail);
        if (path.endsWith("/locations")) {
          return json([
            { id: "loc-received", code: "RECV", status: "received", name: "Received" },
          ]);
        }
        if (path.endsWith("/cases")) return json([]);
        if (path.endsWith("/organizations")) return json([]);
        return json([]);
      }),
    );

    const fakeCase = detail as unknown as LabCase;
    const Wrapper = makeAuthWrapper("/cases", {
      user: { id: "owner-1", username: "owner", role } as SessionUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={fakeCase} onClose={() => {}} />)}
      </Wrapper>,
    );
    const patchBodies = () =>
      requests
        .filter((r) => r.method === "PATCH" && r.path.endsWith(`/cases/${caseId}`))
        .map((r) => r.body);
    return { requests, patchBodies };
  }

  /** Locate the case to the intake station, which is what opens the wizard. */
  async function locateToReceived() {
    const locateSelect = await screen.findByTestId("locate-case-select");
    await screen.findByRole("option", { name: "Received" });
    fireEvent.change(locateSelect, { target: { value: "loc-received" } });
  }

  /** Click a button inside the wizard panel identified by `testId`. */
  async function answer(testId: string, name: string) {
    const panel = await screen.findByTestId(testId);
    fireEvent.click(within(panel).getByRole("button", { name }));
  }

  beforeEach(() => {
    vi.mocked(printCaseOverview).mockClear();
    vi.mocked(printCaseLabel).mockClear();
  });

  it("presents the questions as a centered popup above the drawer", async () => {
    renderReturnCase();
    await locateToReceived();

    const dialog = await screen.findByTestId("return-wizard-dialog");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // A fixed 4in × 4in (384 × 384 px) panel…
    expect(dialog.className).toContain("w-96");
    expect(dialog.className).toContain("h-96");
    // …centred over a dimmed full-screen backdrop, not tucked into the drawer.
    const overlay = screen.getByTestId("return-wizard-overlay");
    expect(overlay.className).toContain("fixed");
    expect(overlay.className).toContain("inset-0");
    expect(overlay.className).toContain("items-center");
    expect(overlay.className).toContain("justify-center");
    expect(screen.queryByTestId("locate-case-submit")).not.toBeInTheDocument();

    // The question title lives in the popup header and follows the flow.
    expect(screen.getByTestId("return-wizard-title")).toHaveTextContent(
      "This case is complete — set a new due date?",
    );
    await answer("return-wizard-due-ask", "No");
    await waitFor(() => {
      expect(screen.getByTestId("return-wizard-title")).toHaveTextContent(
        "Scan a new prescription?",
      );
    });
    expect(screen.getByTestId("return-wizard-dialog")).toBeInTheDocument();
  }, 20000);

  it("Escape skips the remaining questions without undoing the locate", async () => {
    const { patchBodies } = renderReturnCase();
    await locateToReceived();
    await answer("return-wizard-due-ask", "No");
    await screen.findByTestId("return-wizard-rx-ask");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("return-wizard-dialog")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("return-wizard-remake-ask")).not.toBeInTheDocument();
    expect(patchBodies()).toEqual([{ status: "received", labLocationId: "loc-received" }]);
  }, 20000);

  it("marks a newly uploaded returned-case prescription with durable provenance", async () => {
    const { requests } = renderReturnCase();
    await locateToReceived();
    await answer("return-wizard-due-ask", "No");
    await answer("return-wizard-rx-ask", "Yes");

    const input = await screen.findByTestId("return-rx-file-input");
    fireEvent.change(input, {
      target: {
        files: [new File(["rx"], "new-prescription.jpg", { type: "image/jpeg" })],
      },
    });

    await waitFor(() => {
      const upload = requests.find(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith(`/cases/${caseId}/attachments`),
      );
      expect(upload?.body).toMatchObject({
        fileName: "new-prescription.jpg",
        fileType: "image/jpeg",
        category: "prescription",
      });
    });
  }, 20000);

  it("asks every question in order and applies each answer", async () => {
    const { requests, patchBodies } = renderReturnCase();
    await locateToReceived();

    // 1. Due date — decline, which locates the case as-is.
    await answer("return-wizard-due-ask", "No");
    await waitFor(() => {
      expect(patchBodies()).toEqual([{ status: "received", labLocationId: "loc-received" }]);
    });

    // 2. Prescription — skip.
    await answer("return-wizard-rx-ask", "No");
    // 3. Remake — skip.
    await answer("return-wizard-remake-ask", "No");

    // 4. Removable — pick a new step.
    await answer("return-wizard-step-ask", "Yes");
    const stepSelect = screen.getByTestId("return-step-select") as HTMLSelectElement;
    expect(stepSelect.value).toBe("wax_setup");
    fireEvent.change(stepSelect, { target: { value: "process" } });
    fireEvent.click(screen.getByRole("button", { name: "Update Step" }));
    await waitFor(() => {
      expect(patchBodies()).toEqual([
        { status: "received", labLocationId: "loc-received" },
        { step: "process" },
      ]);
    });

    // 5. Notes — write one through the shared composer.
    await answer("return-wizard-notes-ask", "Yes");
    const notesPanel = await screen.findByTestId("return-wizard-notes");
    fireEvent.change(within(notesPanel).getByPlaceholderText("Add a note…"), {
      target: { value: "Back from the doctor for an adjustment." },
    });
    fireEvent.click(within(notesPanel).getByRole("button", { name: "Add note" }));
    await waitFor(() => {
      expect(
        requests.find((r) => r.path.endsWith(`/cases/${caseId}/notes`))?.body,
      ).toMatchObject({
        noteText: "Back from the doctor for an adjustment.",
        visibility: "internal_lab_only",
      });
    });

    // 6 + 7. Both reprints.
    await answer("return-wizard-lab-slip-ask", "Yes");
    await waitFor(() => {
      expect(printCaseOverview).toHaveBeenCalledTimes(1);
    });
    await answer("return-wizard-label-ask", "Yes");
    await waitFor(() => {
      expect(printCaseLabel).toHaveBeenCalledTimes(1);
    });

    // The wizard closes once the last question is answered.
    await waitFor(() => {
      expect(screen.queryByTestId("return-wizard-label-ask")).not.toBeInTheDocument();
    });
  }, 20000);

  it("skips straight through when every answer is No", async () => {
    const { patchBodies } = renderReturnCase();
    await locateToReceived();

    await answer("return-wizard-due-ask", "No");
    await answer("return-wizard-rx-ask", "No");
    await answer("return-wizard-remake-ask", "No");
    await answer("return-wizard-step-ask", "No");
    await answer("return-wizard-notes-ask", "No");
    await answer("return-wizard-lab-slip-ask", "No");
    await answer("return-wizard-label-ask", "No");

    await waitFor(() => {
      expect(screen.queryByTestId("return-wizard-label-ask")).not.toBeInTheDocument();
    });
    expect(patchBodies()).toEqual([{ status: "received", labLocationId: "loc-received" }]);
    expect(printCaseOverview).not.toHaveBeenCalled();
    expect(printCaseLabel).not.toHaveBeenCalled();
  }, 20000);

  it("uploads a dropped prescription and attaches it to the case", async () => {
    const { requests } = renderReturnCase();
    await locateToReceived();
    await answer("return-wizard-due-ask", "No");
    await answer("return-wizard-rx-ask", "Yes");

    const dropzone = await screen.findByTestId("return-rx-dropzone");
    const file = new File(["rx"], "new-rx.pdf", { type: "application/pdf" });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file], types: ["Files"] } });

    await waitFor(() => {
      expect(
        requests.find((r) => r.path.endsWith(`/cases/${caseId}/attachments`))?.body,
      ).toMatchObject({ fileName: "new-rx.pdf", storageKey: "media/new-rx.pdf" });
    });
    // A successful upload advances to the next question.
    await screen.findByTestId("return-wizard-remake-ask");
  }, 20000);

  it("uploads a prescription chosen from the computer", async () => {
    const { requests } = renderReturnCase();
    await locateToReceived();
    await answer("return-wizard-due-ask", "No");
    await answer("return-wizard-rx-ask", "Yes");

    const input = screen.getByTestId("return-rx-file-input");
    const file = new File(["rx"], "picked-rx.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(
        requests.find((r) => r.path.endsWith(`/cases/${caseId}/attachments`))?.body,
      ).toMatchObject({ fileName: "picked-rx.png" });
    });
    await screen.findByTestId("return-wizard-remake-ask");
  }, 20000);

  it("explains instead of offering an upload box for mobile-created cases", async () => {
    renderReturnCase({ detail: { _source: "mobile" } });
    await locateToReceived();
    await answer("return-wizard-due-ask", "No");

    const rxPanel = await screen.findByTestId("return-wizard-rx-ask");
    expect(rxPanel).toHaveTextContent(/created in the mobile app/i);
    expect(within(rxPanel).queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();

    fireEvent.click(within(rxPanel).getByRole("button", { name: "Continue" }));
    await screen.findByTestId("return-wizard-remake-ask");
  }, 20000);

  it("opens the remake protocol when the case is a remake", async () => {
    renderReturnCase();
    await locateToReceived();
    await answer("return-wizard-due-ask", "No");
    await answer("return-wizard-rx-ask", "No");
    await answer("return-wizard-remake-ask", "Yes");

    const remakePanel = await screen.findByTestId("return-wizard-remake");
    expect(
      within(remakePanel).getByPlaceholderText(/Search by case #, patient, or doctor/i),
    ).toBeInTheDocument();
    // Nothing is linked until an original case is picked.
    expect(within(remakePanel).getByRole("button", { name: /Link Remake/ })).toBeDisabled();
  }, 20000);

  it("skips the removable step question for viewers who cannot change the step", async () => {
    renderReturnCase({ role: "staff" });
    await locateToReceived();
    await answer("return-wizard-due-ask", "No");
    await answer("return-wizard-rx-ask", "No");
    await answer("return-wizard-remake-ask", "No");

    await screen.findByTestId("return-wizard-notes-ask");
    expect(screen.queryByTestId("return-wizard-step-ask")).not.toBeInTheDocument();
  }, 20000);

  it("closing the panel skips the remaining questions without undoing anything", async () => {
    const { patchBodies } = renderReturnCase();
    await locateToReceived();
    await answer("return-wizard-due-ask", "No");
    await answer("return-wizard-rx-ask", "Close");

    await waitFor(() => {
      expect(screen.queryByTestId("return-wizard-rx-ask")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("return-wizard-remake-ask")).not.toBeInTheDocument();
    // The locate that already happened stays applied.
    expect(patchBodies()).toEqual([{ status: "received", labLocationId: "loc-received" }]);
  }, 20000);

  it("does not run the wizard for locates that are not complete-to-intake", async () => {
    const { patchBodies } = renderReturnCase({ detail: { status: "in_design" } });
    await locateToReceived();

    await waitFor(() => {
      expect(patchBodies()).toEqual([{ status: "received", labLocationId: "loc-received" }]);
    });
    expect(screen.queryByTestId("return-wizard-due-ask")).not.toBeInTheDocument();
    expect(screen.queryByTestId("return-wizard-rx-ask")).not.toBeInTheDocument();
  }, 20000);
});

// The Invoice tab card lists payments recorded against the case invoice
// (date, method/reference, amount) below the line items and summary. This
// test stubs the invoice + invoice-detail endpoints with a recorded payment
// and asserts the "Payments received" section renders it.
describe("CaseDrawer invoice payments", () => {
  it("lists recorded payments on the Invoice tab", async () => {
    const caseId = "case-1";

    const json = (body: unknown, status = 200) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;
        const search = new URL(url, "http://localhost").search;

        if (path.endsWith("/invoices") && search.includes("caseId=")) {
          return json([
            {
              id: "inv-1",
              invoiceNumber: "INV-26-1",
              status: "partially_paid",
              total: "200.00",
              balanceDue: "50.00",
              labOrganizationId: "lab-1",
              providerOrganizationId: "prov-1",
            },
          ]);
        }
        if (path.endsWith("/invoices/inv-1")) {
          return json({
            id: "inv-1",
            invoiceNumber: "INV-26-1",
            status: "partially_paid",
            total: "200.00",
            balanceDue: "50.00",
            labOrganizationId: "lab-1",
            providerOrganizationId: "prov-1",
            items: [],
            payments: [
              {
                id: "pay-1",
                invoiceId: "inv-1",
                amount: "150.00",
                paymentMethod: "check",
                referenceNumber: "1234",
                paidAt: "2026-06-20T10:00:00.000Z",
              },
            ],
          });
        }
        if (path.endsWith(`/cases/${caseId}`)) {
          return json({
            id: caseId,
            caseNumber: "26-1",
            patientFirstName: "Jane",
            patientLastName: "Doe",
            doctorName: "Dr. Synthetic063",
            status: "received",
            priority: "normal",
            dueDate: null,
            createdAt: "2026-01-15T10:00:00.000Z",
            updatedAt: "2026-01-15T10:00:00.000Z",
            totalPrice: "200",
            restorations: [],
            notes: [],
          });
        }
        if (path.endsWith("/cases")) return json([]);
        if (path.endsWith("/organizations")) return json([]);
        return json({});
      }),
    );

    const fakeCase = {
      id: caseId,
      caseNumber: "26-1",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      doctorName: "Dr. Synthetic063",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "200",
    } as unknown as LabCase;

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={fakeCase} onClose={() => {}} />)}
      </Wrapper>,
    );

    // Switch to the Invoice tab.
    const invoiceTab = await screen.findByRole("tab", { name: "Invoice" });
    fireEvent.click(invoiceTab!);

    // The payments section header and the recorded payment row render.
    expect(await screen.findByText(/Payments received/i)).toBeInTheDocument();
    expect(screen.getByText("Check", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/1234/)).toBeInTheDocument();
    expect(screen.getByText("$150.00")).toBeInTheDocument();
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
    const OLD = "2026-06-25"; // formatDueDate -> "06/25/2026"
    const NEW = "2026-07-10"; // formatDueDate -> "07/10/2026"

    const detailBody = (due: string) =>
      JSON.stringify({
        id: caseId,
        caseNumber: "26-1",
        patientFirstName: "Jane",
        patientLastName: "Doe",
        doctorName: "Dr. Synthetic063",
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
    let patchCalls = 0;
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
          if (method === "PATCH") {
            patchCalls += 1;
            return json("{}");
          }
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
      doctorName: "Dr. Synthetic063",
      status: "received",
      priority: "normal",
      // The list row is intentionally stale; wait for the detail request to
      // provide the authoritative starting due date before editing.
      dueDate: "2026-06-24",
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
    const dates = screen.getByTestId("case-details-dates");
    await waitFor(() => {
      expect(within(dates).getByTestId("case-details-due-date"))
        .toHaveTextContent("06/25/2026");
    });

    // Open the edit form.
    fireEvent.click(screen.getByTestId("case-details-edit"));

    // Change the due date.
    const dateInput = document.querySelector(
      `input[type="date"][value="${OLD}"]`,
    ) as HTMLInputElement | null;
    expect(dateInput).toBeTruthy();
    fireEvent.change(dateInput!, { target: { value: NEW } });

    // One press writes immediately; the form remains open through the refetch.
    fireEvent.click(screen.getByTestId("case-details-edit-save"));
    await waitFor(() => expect(patchCalls).toBe(1));

    // While the refetch is held open, the new value must remain on screen and
    // the old value must never flash back.
    await waitFor(() => expect(detailCalls).toBeGreaterThan(1));
    expect(dateInput).toHaveValue(NEW);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(within(dates).getByTestId("case-details-due-date"))
      .not.toHaveTextContent("06/25/2026");

    // Release the refetch -> server returns the new value -> still shown.
    releaseRefetch();
    await waitFor(() => {
      expect(within(dates).getByTestId("case-details-due-date"))
        .toHaveTextContent("07/10/2026");
    });
    expect(within(dates).getByTestId("case-details-due-date")).toHaveTextContent("07/10/2026");
    expect(within(dates).getByTestId("case-details-date-created")).toHaveTextContent("01/15/2026");
    expect(screen.getAllByTestId("case-details-due-date")).toHaveLength(1);
  });

  it("saves a calendar-selected due date immediately and preserves its time", async () => {
    const caseId = "quick-due-date-case";
    const OLD = "2026-06-25";
    const NEW = "2026-07-10";
    let currentDueDate = OLD;
    let patchBody: Record<string, unknown> | null = null;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const detail = () => ({
      id: caseId,
      caseNumber: "26-2",
      patientFirstName: "Synthetic",
      patientLastName: "Case",
      doctorName: "Dr. Synthetic",
      status: "received",
      priority: "normal",
      dueDate: currentDueDate,
      dueTime: "15:30",
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "synthetic-lab",
      viewerIsLabMember: true,
      restorations: [],
      notes: [],
      attachments: [],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (path.endsWith(`/cases/${caseId}`) && method === "PATCH") {
          const parsedPatchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          patchBody = parsedPatchBody;
          currentDueDate = String(parsedPatchBody.dueDate);
          return json(detail());
        }
        if (path.endsWith(`/cases/${caseId}`)) return json(detail());
        if (path.endsWith("/cases")) return json([]);
        if (path.endsWith("/organizations")) return json([]);
        if (path.endsWith("/vocabulary") || path.endsWith("/finance/vendors")) return json([]);
        return json({});
      }),
    );

    const fakeCase = {
      ...detail(),
      dueDate: OLD,
    } as unknown as LabCase;
    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={fakeCase} onClose={() => {}} />)}
      </Wrapper>,
    );

    const dueDateRow = await screen.findByTestId("case-details-due-date");
    await waitFor(() => expect(dueDateRow).toHaveTextContent("06/25/2026"));
    const dateInput = screen.getByTestId(
      "case-details-due-date-picker-input",
    ) as HTMLInputElement;
    expect(dateInput).toHaveValue(OLD);

    fireEvent.change(dateInput, { target: { value: NEW } });

    await waitFor(() => expect(patchBody).toEqual({
      dueDate: NEW,
      dueTime: "15:30",
    }));
    await waitFor(() => expect(dueDateRow).toHaveTextContent("07/10/2026 at 3:30 PM"));
  });

  it("reverts the displayed date and reports a rejected quick save", async () => {
    const caseId = "quick-due-date-rejected-case";
    const OLD = "2026-06-25";
    const NEW = "2026-07-10";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const detail = () => ({
      id: caseId,
      caseNumber: "26-3",
      patientFirstName: "Synthetic",
      patientLastName: "Case",
      doctorName: "Dr. Synthetic",
      status: "received",
      priority: "normal",
      dueDate: OLD,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
      labOrganizationId: "synthetic-lab",
      viewerIsLabMember: true,
      restorations: [],
      notes: [],
      attachments: [],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (path.endsWith(`/cases/${caseId}`) && method === "PATCH") {
          return json({ message: "Date update denied." }, 403);
        }
        if (path.endsWith(`/cases/${caseId}`)) return json(detail());
        if (path.endsWith("/cases")) return json([]);
        if (path.endsWith("/organizations")) return json([]);
        if (path.endsWith("/vocabulary") || path.endsWith("/finance/vendors")) return json([]);
        return json({});
      }),
    );

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        {withAiPanel(
          <CaseDrawer labCase={detail() as unknown as LabCase} onClose={() => {}} />,
        )}
      </Wrapper>,
    );

    const dueDateRow = await screen.findByTestId("case-details-due-date");
    const dateInput = screen.getByTestId(
      "case-details-due-date-picker-input",
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: NEW } });

    await waitFor(() => expect(dueDateRow).toHaveTextContent("06/25/2026"));
    expect(dueDateRow).not.toHaveTextContent("07/10/2026");
  });
});

// Task #2621: the duplicate-doctor checkpoint must be unavoidable. Even when the
// pre-submit /cases/doctor-similarity probe fails (so the client never opens the
// modal proactively), the server returns 409 DOCTOR_CONFIRMATION_REQUIRED on
// POST /cases. The mutation's onError must detect that and open the same
// confirmation modal so the user still has to choose a doctor before saving.
describe("NewCaseModal server-side duplicate-doctor fallback", () => {
  it("opens the doctor confirmation modal from a POST /cases 409 when the preflight probe failed", async () => {
    const json = (body: unknown, status = 200) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    let postAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();

        if (path.endsWith("/organizations")) {
          return json([
            { id: "lab-1", type: "lab", name: "Acme Lab", displayName: "Acme Lab" },
            { id: "prov-1", type: "provider", name: "Bright Dental", displayName: "Bright Dental" },
          ]);
        }
        // Pre-submit doctor-similarity probe FAILS -> client falls through to
        // submit without proactively showing the modal.
        if (path.endsWith("/cases/doctor-similarity")) {
          return json({ message: "probe unavailable" }, 500);
        }
        // No patient duplicates -> proceed straight to the create call.
        if (path.endsWith("/cases/patient-similarity")) {
          return json({ matches: [] });
        }
        if (path.endsWith("/cases") && method === "POST") {
          postAttempts += 1;
          return json(
            {
              ok: false,
              message: "Confirm the doctor for this case.",
              details: {
                code: "DOCTOR_CONFIRMATION_REQUIRED",
                doctorName: "Kanesha Cole",
                providerOrganizationId: "prov-1",
                candidates: [
                  {
                    doctorName: "Dr. Kanesha Cole",
                    providerOrganizationId: "prov-1",
                    totalCases: 3,
                    similarity: 0.92,
                  },
                ],
              },
            },
            409,
          );
        }
        if (path.endsWith("/cases")) return json([]);
        return json({});
      }),
    );

    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<NewCaseModal onClose={() => {}} />)}</Wrapper>);

    // Select the lab (native select).
    const labSelect = document.querySelector("select") as HTMLSelectElement | null;
    expect(labSelect).toBeTruthy();
    await waitFor(() => {
      expect(
        Array.from(labSelect!.options).some((o) => o.value === "lab-1"),
      ).toBe(true);
    });
    fireEvent.change(labSelect!, { target: { value: "lab-1" } });

    // Select the practice via the ProviderPicker (button -> option).
    fireEvent.click(screen.getByText("Select practice…"));
    fireEvent.click(await screen.findByText("Bright Dental"));

    // Patient name.
    fireEvent.change(screen.getByPlaceholderText("First"), {
      target: { value: "Jane" },
    });
    fireEvent.change(screen.getByPlaceholderText("Last"), {
      target: { value: "Doe" },
    });

    // Doctor name (FieldCombobox input).
    fireEvent.change(
      within(screen.getByRole("dialog", { name: "Add case" })).getByPlaceholderText("Dr. Smith"),
      {
      target: { value: "Kanesha Cole" },
      },
    );

    // Submit the form -> doctor-similarity probe 500s -> patient probe empty ->
    // POST /cases 409 -> onError opens the confirmation modal.
    const form = document.querySelector("form") as HTMLFormElement | null;
    expect(form).toBeTruthy();
    fireEvent.submit(form!);

    // The server-driven confirmation modal appears with the existing candidate.
    expect(await screen.findByText("Which doctor do you mean?")).toBeInTheDocument();
    expect(screen.getByText("Dr. Kanesha Cole")).toBeInTheDocument();
    expect(postAttempts).toBe(1);
  });
});

// Task #2668: the Cases page persists its filters in sessionStorage under
// `cases_filters_v4` so they survive opening/closing the case-detail drawer
// (which keeps the page mounted on /cases), but an unmount — i.e. navigating
// to another section entirely — must clear the persisted entry so the list
// reloads unfiltered next time. This dual behavior has no other coverage.
// (Bumped from v2→v3 when the type filter switched from raw caseType keys to
// category keys so stale v2 values don't silently hide all cases on first load;
// v3→v4 when status/priority/type became multi-select arrays.)
const CASES_FILTER_STORAGE_KEY = "cases_filters_v4";

function seedCasesFilters(overrides: Record<string, unknown> = {}) {
  sessionStorage.setItem(
    CASES_FILTER_STORAGE_KEY,
    JSON.stringify({
      search: "",
      statusFilters: [],
      priorityFilters: [],
      caseTypeFilters: [],
      dateRangeFilter: "all",
      customStartDate: "",
      customEndDate: "",
      sortKey: "createdAt",
      sortDir: "desc",
      ...overrides,
    }),
  );
}

describe("CasesPage persisted-filter lifecycle", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("clears the persisted filters when the page unmounts (leaving Cases)", () => {
    seedCasesFilters({ search: "Jane", statusFilters: ["received"] });

    const Wrapper = makeAuthWrapper("/cases");
    const { unmount } = render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // While mounted the entry exists (the page re-persists it on mount).
    expect(sessionStorage.getItem(CASES_FILTER_STORAGE_KEY)).not.toBeNull();

    // Unmounting the page (route change to another section) clears it.
    unmount();
    expect(sessionStorage.getItem(CASES_FILTER_STORAGE_KEY)).toBeNull();
  });

  it("keeps the persisted filters when a case drawer opens (page stays mounted)", () => {
    seedCasesFilters({ search: "Jane", statusFilters: ["received"] });

    const fakeCase = {
      id: "case-1",
      caseNumber: "26-1",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      doctorName: "Dr. Synthetic063",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
    } as unknown as LabCase;

    const Wrapper = makeAuthWrapper("/cases");
    const { rerender } = render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);
    expect(sessionStorage.getItem(CASES_FILTER_STORAGE_KEY)).not.toBeNull();

    // Opening a case detail keeps CasesPage mounted (same /cases route) and
    // renders the drawer alongside it, so the persisted entry must survive.
    rerender(
      <Wrapper>
        {withAiPanel(
          <>
            <CasesPage />
            <CaseDrawer labCase={fakeCase} onClose={() => {}} />
          </>,
        )}
      </Wrapper>,
    );
    expect(sessionStorage.getItem(CASES_FILTER_STORAGE_KEY)).not.toBeNull();

    // Closing the drawer (still on /cases) also preserves it.
    rerender(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);
    expect(sessionStorage.getItem(CASES_FILTER_STORAGE_KEY)).not.toBeNull();
  });

  it("restores the persisted filters to the toolbar on mount (not just the search)", () => {
    // Seed a full round-trip's worth of filters as if the user applied them,
    // opened a case detail, and is now coming BACK to Cases. The page must
    // re-hydrate every control from `cases_filters_v4`, not just the search.
    // Status carries MULTIPLE persisted values, so the multi-select has to
    // rehydrate the whole set, not collapse it to the first one.
    seedCasesFilters({
      search: "Jane",
      statusFilters: ["in_porcelain", "received"],
      priorityFilters: ["rush"],
      caseTypeFilters: ["removable"],
      dateRangeFilter: "30",
    });

    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // Text search is restored into the toolbar input.
    const searchInput = screen.getByPlaceholderText(
      "Search case #, doctor, patient…",
    ) as HTMLInputElement;
    expect(searchInput.value).toBe("Jane");

    // Each multi-select trigger summarizes its restored selection.
    expect(screen.getByTestId("cases-status-filter")).toHaveTextContent(
      "Location: 2 selected",
    );
    expect(screen.getByTestId("cases-priority-filter")).toHaveTextContent(
      "Priority: Rush",
    );
    expect(screen.getByTestId("cases-type-filter")).toHaveTextContent(
      "Type: Removable",
    );

    // Opening Status shows exactly the two restored values checked.
    fireEvent.click(screen.getByTestId("cases-status-filter"));
    expect(
      screen.getByRole("menuitemcheckbox", { name: /^Porcelain$/i }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: /^Received$/i }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: /^In Design$/i }),
    ).toHaveAttribute("aria-checked", "false");

    // The date range is still a plain <select> and keeps its persisted value.
    const dateSelect = (
      Array.from(document.querySelectorAll("select")) as HTMLSelectElement[]
    ).find((s) => Array.from(s.options).some((o) => o.value === "30"));
    expect(dateSelect?.value).toBe("30");

    // A restored non-default filter also enables the Reset filters affordance.
    expect(
      screen.getByRole("button", { name: /Reset filters/i }),
    ).not.toBeDisabled();
  });

  it("restores the persisted scroll position to the list container on mount", async () => {
    // Task #2683: the Cases page persists the scroll container's scrollTop in
    // sessionStorage under `cases_scroll_v1` and restores it on mount so
    // returning from a case drops you back where you left off. Seed a non-zero
    // value, mount the page inside a scroll container (a <main>, which is what
    // the restore effect walks up to via pageRef.closest("main")), and assert
    // the container's scrollTop is restored. Removing/breaking the restore
    // effect makes this fail.
    const CASES_SCROLL_STORAGE_KEY = "cases_scroll_v1";
    sessionStorage.setItem(CASES_SCROLL_STORAGE_KEY, "420");

    const Wrapper = makeAuthWrapper("/cases");
    render(
      <Wrapper>
        <main data-testid="cases-scroll-container">
          {withAiPanel(<CasesPage />)}
        </main>
      </Wrapper>,
    );

    const container = screen.getByTestId(
      "cases-scroll-container",
    ) as HTMLElement;

    await waitFor(() => {
      expect(container.scrollTop).toBe(420);
    });
  });

  it("Reset filters clears every in-scope filter but leaves sort order untouched", async () => {
    // Seed an active filter plus a non-default sort. The persist effect keeps
    // sessionStorage in sync with state, so after reset we can read it back to
    // assert the filters cleared while the sort was preserved.
    seedCasesFilters({ search: "Jane", sortKey: "doctorName", sortDir: "asc" });

    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // The seeded search populates the toolbar input and enables the button.
    const searchInput = screen.getByPlaceholderText(
      "Search case #, doctor, patient…",
    ) as HTMLInputElement;
    expect(searchInput.value).toBe("Jane");

    const resetBtn = screen.getByRole("button", { name: /Reset filters/i });
    expect(resetBtn).not.toBeDisabled();
    fireEvent.click(resetBtn);

    // Filters clear immediately in the UI.
    expect(searchInput.value).toBe("");
    expect(resetBtn).toBeDisabled();

    // The persist effect re-writes the entry with cleared filters and the
    // original (untouched) sort order.
    await waitFor(() => {
      const raw = sessionStorage.getItem(CASES_FILTER_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const persisted = JSON.parse(raw!);
      expect(persisted.search).toBe("");
      expect(persisted.statusFilters).toEqual([]);
      expect(persisted.priorityFilters).toEqual([]);
      expect(persisted.caseTypeFilters).toEqual([]);
      expect(persisted.dateRangeFilter).toBe("all");
      // Sort order is a display preference and must be preserved.
      expect(persisted.sortKey).toBe("doctorName");
      expect(persisted.sortDir).toBe("asc");
    });
  });
});

// Task #2684: after an iTero import, the Cases page stashes the active batch in
// `cases_itero_batch_v1`, restores it on mount (so the just-imported batch view
// shows), and then removes the key so the batch banner surfaces exactly once —
// it must not re-appear on every subsequent visit. Neither half had coverage.
const CASES_ITERO_BATCH_KEY = "cases_itero_batch_v1";

function seedIteroActiveBatch(overrides: Record<string, unknown> = {}) {
  sessionStorage.setItem(
    CASES_ITERO_BATCH_KEY,
    JSON.stringify({
      batchId: "batch-1",
      caseIds: ["case-1", "case-2"],
      importedAt: "2026-01-15T10:00:00.000Z",
      label: "Dr. Synthetic063",
      ...overrides,
    }),
  );
}

describe("CasesPage iTero import-batch restore-then-clear", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("restores the stashed batch on mount and removes the key so it shows once", async () => {
    seedIteroActiveBatch();

    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // The restored batch state renders its dedicated banner, confirming the
    // imported-batch view was applied on mount.
    expect(
      await screen.findByText(/Filtered to iTero import session/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Dr\. Synthetic063/)).toBeInTheDocument();

    // The mount effect clears the storage key immediately so returning to
    // Cases later won't re-surface the same batch banner.
    expect(sessionStorage.getItem(CASES_ITERO_BATCH_KEY)).toBeNull();
  });

  it("does not show the batch banner on a fresh mount when no batch is stashed", () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // With nothing stashed the banner must not appear — this is the "second
    // visit" state after the key was already consumed and cleared.
    expect(
      screen.queryByText(/Filtered to iTero import session/i),
    ).not.toBeInTheDocument();
    expect(sessionStorage.getItem(CASES_ITERO_BATCH_KEY)).toBeNull();
  });

  it("clears a lingering batch key when the page unmounts (leaving Cases)", () => {
    // Mirrors the persisted-filter "clears on unmount" test. The mount effect
    // consumes any pre-existing batch key, so seed it AFTER mount to simulate a
    // batch key that lingers while the page is open. Navigating away from /cases
    // entirely (unmount) must remove it so it can't re-surface the banner later.
    const Wrapper = makeAuthWrapper("/cases");
    const { unmount } = render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // Simulate a batch key present while the page is mounted.
    seedIteroActiveBatch();
    expect(sessionStorage.getItem(CASES_ITERO_BATCH_KEY)).not.toBeNull();

    // Unmounting the page (route change to another section) clears it.
    unmount();
    expect(sessionStorage.getItem(CASES_ITERO_BATCH_KEY)).toBeNull();
  });
});

describe("CaseDrawer view-mode hierarchy on empty cases", () => {
  it.each(["admin", "owner", "technician"] as const)("keeps the empty-case control permission-gated for %s", async (role) => {
    const caseId = "case-no-rx";

    const adminUser: SessionUser = {
      id: "u-admin",
      username: "labadmin",
      role,
    };

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;

        if (path.endsWith(`/cases/${caseId}`)) {
          return json({
            id: caseId,
            caseNumber: "26-99",
            patientFirstName: "Alex",
            patientLastName: "Patel",
            doctorName: "Dr. Synthetic047",
            status: "received",
            priority: "normal",
            dueDate: null,
            createdAt: "2026-01-15T10:00:00.000Z",
            updatedAt: "2026-01-15T10:00:00.000Z",
            totalPrice: "0",
            restorations: [],
            notes: [],
          });
        }
        if (path.endsWith("/cases")) return json([]);
        if (path.endsWith("/organizations")) return json([]);
        return json({});
      }),
    );

    const fakeCase = {
      id: caseId,
      caseNumber: "26-99",
      patientFirstName: "Alex",
      patientLastName: "Patel",
      doctorName: "Dr. Synthetic047",
      status: "received",
      priority: "normal",
      dueDate: null,
      createdAt: "2026-01-15T10:00:00.000Z",
      updatedAt: "2026-01-15T10:00:00.000Z",
      totalPrice: "0",
    } as unknown as LabCase;

    const Wrapper = makeAuthWrapper("/cases", {
      user: adminUser,
      status: "authed",
    });
    render(
      <Wrapper>
        {withAiPanel(<CaseDrawer labCase={fakeCase} onClose={() => {}} />)}
      </Wrapper>,
    );

    // Wait for the drawer to fully load (patient name appears in header).
    await screen.findAllByText(/Alex/);

    // Empty cases use the case-level operation; no restoration ID is required.
    const selects = Array.from(
      document.querySelectorAll("select"),
    ) as HTMLSelectElement[];
    const caseTypeSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === "restorative"),
    );
    if (role === "technician") {
      expect(caseTypeSelect).toBeUndefined();
    } else {
      expect(caseTypeSelect).toBeDefined();
      expect(caseTypeSelect!.value).toBe("");
      expect(caseTypeSelect!.disabled).toBe(false);
    }

    // The static label "—" (em-dash) must be present as the fallback display.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
