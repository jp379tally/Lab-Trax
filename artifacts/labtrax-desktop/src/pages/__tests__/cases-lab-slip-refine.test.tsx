/** @vitest-environment jsdom */
/**
 * Lab Slip layout + read-only tooth display regressions.
 *
 * The slip now leads with Case Details (schedule + priority), then the case
 * number, then the practice block, then the read-only tooth value. These tests
 * pin the parts that are easy to break silently: tooth values stay separate
 * from shade editing, no other practice's contact details can appear, Step is
 * removable-only, and duplicated Locate Case / notes blocks stay gone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { CaseDrawer } from "@/pages/cases";
import type { LabCase } from "@/lib/types";
import type { SessionUser } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";
import { toast } from "sonner";

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

const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface HarnessOptions {
  detail: Record<string, unknown>;
  /** Lab shade vocabulary returned for this lab. */
  shades?: string[];
  organizations?: Array<Record<string, unknown>>;
  locations?: Array<Record<string, unknown>>;
  hierarchyResult?: Record<string, unknown>;
  chartFailure?: string;
  routeFailure?: string;
}

interface Harness {
  patches: Array<{ path: string; body: unknown }>;
  detailFetches: () => number;
  render: () => void;
}

/**
 * Serves a single case detail that actually applies restoration PATCHes, so a
 * refetch returns what the server would really hold afterwards.
 */
function makeHarness(options: HarnessOptions): Harness {
  const caseId = String(options.detail.id);
  const detail = JSON.parse(JSON.stringify(options.detail)) as Record<string, unknown>;
  const patches: Array<{ path: string; body: unknown }> = [];
  let detailFetches = 0;
  let routeFailure = options.routeFailure;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      // Recorded without the shared `/api` prefix so assertions read like the
      // routes the drawer asks for.
      const path = new URL(url, "http://localhost").pathname.replace(/^\/api/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (method === "PATCH" && path.endsWith(`/cases/${caseId}/tooth-chart`)) {
        patches.push({ path, body });
        if (options.chartFailure) return json({ error: options.chartFailure }, 409);
        const rows = (detail.restorations ?? []) as Array<Record<string, unknown>>;
        detail.restorations = [
          ...rows.filter((row) => !body.deletes.includes(row.id)).map((row) => ({
            ...row, ...body.updates.find((update: Record<string, unknown>) => update.restorationId === row.id),
          })),
          ...body.creates.map((row: Record<string, unknown>) => ({ ...row, id: row.localId, caseId })),
        ];
        detail.bridgeConnectors = body.bridgeConnectors;
        return json({ ok: true, data: { invoiceAction: "updated", invoiceId: "synthetic-invoice" } });
      }
      if (
        method === "PATCH" &&
        path.endsWith(`/cases/${caseId}/restorations/hierarchy`)
      ) {
        patches.push({ path, body });
        const request = body as Record<string, unknown>;
        const rows = (detail.restorations ?? []) as Array<Record<string, unknown>>;
        const billable = rows.filter((row) => row.restorationType !== "missing");
        const teeth = Array.isArray(request.toothNumbers)
          ? (request.toothNumbers as string[])
          : billable.map((row) => String(row.toothNumber ?? ""));
        const nextRows = teeth.map((toothNumber, index) => {
          const old = billable.find((row) => row.toothNumber === toothNumber);
          const row: Record<string, unknown> = old
            ? { ...old }
            : {
                id: `created-${index}`,
                caseId,
                toothNumber,
                quantity: 1,
                notes: null,
                unitPrice: "0.00",
                priceSource: null,
              };
          row.restorationType = request.restorationType;
          row.restorationSubtype = request.restorationSubtype;
          row.material = request.material;
          if ("shade" in request) row.shade = request.shade;
          if ("arch" in request) row.arch = request.arch;
          return row;
        });
        detail.restorations = [
          ...rows.filter((row) => row.restorationType === "missing"),
          ...nextRows,
        ];
        if ("step" in request) detail.step = request.step;
        if ("stepShade" in request) detail.stepShade = request.stepShade;
        return json({
          ok: true,
          data: {
            updatedCount: nextRows.length,
            createdCount: 0,
            deletedCount: 0,
            repricedCount: 1,
            manualPriceCount: 1,
            unpricedCount: 1,
            invoiceAction: "updated",
            ...options.hierarchyResult,
          },
        });
      }

      if (method === "PATCH" && /\/cases\/[^/]+\/restorations\/[^/]+$/.test(path)) {
        patches.push({ path, body });
        const restorationId = path.split("/").pop();
        const rows = (detail.restorations ?? []) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r.id === restorationId);
        if (row && body && typeof body === "object") {
          for (const key of ["implantRetention", "implantManufacturer", "implantPlatformNotes"]) {
            if (key in body) row[key] = body[key];
          }
        }
        return json(row ?? {});
      }
      if (method === "PATCH" && path.endsWith(`/cases/${caseId}`)) {
        patches.push({ path, body });
        if (routeFailure) {
          const message = routeFailure;
          routeFailure = undefined;
          return json({ error: message }, 409);
        }
        Object.assign(detail, body);
        return json(detail);
      }
      if (path.endsWith(`/cases/${caseId}`)) {
        detailFetches += 1;
        return json(detail);
      }
      if (path.includes("/vocabulary")) {
        const kind = new URL(url, "http://localhost").searchParams.get("kind");
        if (kind === "shade") {
          return json(
            (options.shades ?? ["A1", "A2", "B1", "B2"]).map((value, i) => ({
              id: `shade-${i}`,
              kind: "shade",
              value,
            })),
          );
        }
        return json([]);
      }
      if (path.endsWith("/organizations")) return json(options.organizations ?? []);
      if (path.includes("/locations")) return json(options.locations ?? []);
      if (path.endsWith("/cases")) return json([]);
      return json([]);
    }),
  );

  return {
    patches,
    detailFetches: () => detailFetches,
    render() {
      const Wrapper = makeAuthWrapper("/cases", {
        user: { id: "admin-1", username: "admin", role: "admin" } as SessionUser,
        status: "authed",
      });
      render(
        <Wrapper>
          {withAiPanel(
            <CaseDrawer
              labCase={options.detail as unknown as LabCase}
              onClose={() => {}}
            />,
          )}
        </Wrapper>,
      );
    },
  };
}

function restoration(overrides: Record<string, unknown>) {
  return {
    caseId: "ai-intake-case",
    restorationType: "crown",
    material: "Zirconia",
    quantity: 1,
    unitPrice: "120.00",
    ...overrides,
  };
}

const AI_INTAKE_CASE = {
  id: "ai-intake-case",
  caseNumber: "26-777",
  patientFirstName: "Ada",
  patientLastName: "Shade",
  doctorName: "Dr. Byrne",
  status: "received",
  labLocationId: "station-received",
  labLocationName: "Received",
  priority: "normal",
  dueDate: null,
  createdAt: "2026-01-15T10:00:00.000Z",
  updatedAt: "2026-01-15T10:00:00.000Z",
  totalPrice: "240.00",
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  viewerIsLabMember: true,
  caseNotes: "Deliver with light occlusal contacts.",
  notes: [],
  events: [],
  attachments: [],
  restorations: [
    restoration({ id: "rest-4", toothNumber: "4", shade: "A1" }),
    restoration({ id: "rest-29", toothNumber: "29", shade: "B1" }),
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => json([])));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Lab Slip clinical details", () => {
  it.each(["Lab Slip", "Restorations"])("opens whole-arch assignment from %s without replacing a saved individual crown", async (tab) => {
    const harness = makeHarness({ detail: {
      ...AI_INTAKE_CASE, id: "chart-arch-case",
      restorations: [restoration({ id: "crown-1", toothNumber: "1", restorationType: "Crown", shade: "A2" })],
    } });
    harness.render();
    fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${tab}`) }));
    fireEvent.click(await screen.findByRole("button", { name: "Select upper arch" }));
    fireEvent.click(screen.getByRole("button", { name: "Assign 16 selected teeth" }));
    const dialog = await screen.findByRole("dialog", { name: "Tooth 1 action" });
    expect(within(dialog).queryByRole("button", { name: "Remove restoration" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Denture" }));
    expect(within(dialog).getByRole("button", { name: "upper arch" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(harness.patches).toEqual([]);
  });

  it.each(["Lab Slip", "Restorations"])("adds a Crown from %s with a server-valid stable UUID and one atomic save", async (tab) => {
    const harness = makeHarness({ detail: {
      ...AI_INTAKE_CASE, id: "chart-create-case",
      restorations: [restoration({ id: "crown-2", toothNumber: "2", restorationType: "Crown", shade: "A2" })],
    } });
    harness.render();
    fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${tab}`) }));
    const tooth = await waitFor(() => {
      const node = document.querySelector('[data-tooth-id="5"]');
      expect(node).not.toBeNull(); return node!;
    });
    fireEvent.click(tooth);
    const dialog = await screen.findByRole("dialog", { name: "Tooth 5 action" });
    expect(within(dialog).getByRole("button", { name: "Crown" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Zirconia/ }));
    expect(harness.patches).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Confirm/ }));
    expect(harness.patches).toEqual([]);
    fireEvent.click(screen.getByTestId("case-pending-save"));
    await waitFor(() => expect(harness.patches).toHaveLength(1));
    expect(harness.patches[0]).toMatchObject({
      path: "/cases/chart-create-case/tooth-chart",
      body: { creates: [expect.objectContaining({ toothNumber: "5", restorationType: "Crown", quantity: 1 })], updates: [], deletes: [] },
    });
    const body = harness.patches[0].body as { creates: { localId: string }[] };
    expect(body.creates[0].localId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  });

  it.each(["Lab Slip", "Restorations"])("stages Missing from %s and saves chart/invoice with one request", async (tab) => {
    const harness = makeHarness({ detail: {
      ...AI_INTAKE_CASE, id: "chart-save-case",
      restorations: [restoration({ id: "crown-2", toothNumber: "2", restorationType: "Crown", shade: "A2" })],
    } });
    harness.render();
    fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${tab}`) }));
    const tooth = await waitFor(() => {
      const node = document.querySelector('[data-tooth-id="2"]');
      expect(node).not.toBeNull();
      return node!;
    });
    fireEvent.click(tooth);
    const dialog = await screen.findByRole("dialog", { name: "Tooth 2 action" });
    for (const name of ["Crown", "Pontic", "Veneer", "Missing"]) {
      expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: /Missing/ }));
    expect(harness.patches).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply missing status" }));
    expect(harness.patches).toEqual([]);
    fireEvent.click(screen.getByTestId("case-pending-save"));
    await waitFor(() => expect(harness.patches).toHaveLength(1));
    expect(harness.patches[0]).toMatchObject({
      path: "/cases/chart-save-case/tooth-chart",
      body: { deletes: ["crown-2"], updates: [], creates: [expect.objectContaining({
        toothNumber: "2", restorationType: "missing", quantity: 1, unitPrice: 0,
      })] },
    });
    await waitFor(() => expect(screen.queryByTestId("case-pending-save")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: tab === "Lab Slip" ? /^Restorations/ : /^Lab Slip/ }));
    expect(document.querySelector('[data-tooth-id="2"]')).toHaveAttribute("data-tooth-role", "missing");
  });

  it("canceling Missing makes no writes, and a refused atomic save keeps the draft with an explicit error", async () => {
    const harness = makeHarness({ chartFailure: "The invoice is paid. Nothing was saved.", detail: {
      ...AI_INTAKE_CASE, id: "chart-refused-case", restorations: [],
    } });
    harness.render();
    fireEvent.click(await screen.findByRole("tab", { name: "Lab Slip" }));
    await waitFor(() => expect(document.querySelector('[data-tooth-id="5"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-tooth-id="5"]')!);
    let dialog = await screen.findByRole("dialog", { name: "Tooth 5 action" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Missing/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(harness.patches).toEqual([]);
    fireEvent.click(document.querySelector('[data-tooth-id="5"]')!);
    dialog = await screen.findByRole("dialog", { name: "Tooth 5 action" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Missing/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply missing status" }));
    fireEvent.click(screen.getByTestId("case-pending-save"));
    await screen.findByText(/The invoice is paid. Nothing was saved./);
    expect(screen.getByTestId("case-pending-save")).toBeEnabled();
    expect(harness.patches).toHaveLength(1);
  });

  it("saves implant metadata independently without hierarchy or invoice writes after a label round trip", async () => {
    const harness = makeHarness({
      detail: {
        ...AI_INTAKE_CASE,
        id: "clinical-save-case",
        restorations: [
          restoration({
            id: "implant-14",
            caseId: "clinical-save-case",
            toothNumber: "14",
            restorationType: "Crown",
            restorationSubtype: "restorative/implant/zirconia",
            implantRetention: "Screw retained",
            implantManufacturer: "Straumann",
            implantPlatformNotes: "RC",
          }),
          restoration({
            id: "implant-15",
            caseId: "clinical-save-case",
            toothNumber: "15",
            restorationType: "Crown",
            restorationSubtype: "restorative/implant/zirconia",
            implantRetention: "Cementable",
            implantManufacturer: "Other",
            implantPlatformNotes: "WB",
          }),
        ],
      },
      hierarchyResult: { invoiceAction: "needs_review" },
    });
    harness.render();
    fireEvent.click(await screen.findByTestId("case-details-edit"));
    const notes = screen.getAllByLabelText("Implant Platform Notes");
    fireEvent.change(notes[0], { target: { value: "RN 4.1" } });
    // Free-text/catalog dropdown aliases must not turn Crown + Implant token
    // into a clinical change simply because its displayed label is Implant.
    fireEvent.change(screen.getByLabelText("Subtype"), { target: { value: "Implant" } });
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(harness.patches.some(({ path }) => path.endsWith("/restorations/implant-14"))).toBe(true));
    expect(harness.patches.filter(({ path }) => path.includes("hierarchy") || path.includes("invoice"))).toEqual([]);
    expect(harness.patches.filter(({ path }) => path.includes("/restorations/implant-15"))).toEqual([]);
    expect(harness.patches.find(({ path }) => path.endsWith("/restorations/implant-14"))?.body).toMatchObject({ implantPlatformNotes: "RN 4.1", syncLinkedArch: false });
    await waitFor(() => expect(screen.queryByText("Save changes")).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("case-details-edit"));
    expect((screen.getAllByLabelText("Implant Platform Notes")[0] as HTMLInputElement).value).toBe("RN 4.1");
    expect((screen.getAllByLabelText("Implant Platform Notes")[1] as HTMLInputElement).value).toBe("WB");
  });

  it("shows AI-intake teeth and ranges as read-only text without exposing shade controls", async () => {
    const harness = makeHarness({
      detail: {
        ...AI_INTAKE_CASE,
        id: "clinical-save-case",
        restorations: [
          restoration({
            id: "rest-4",
            caseId: "clinical-save-case",
            toothNumber: "4",
            shade: "A1",
          }),
          restoration({
            id: "rest-range",
            caseId: "clinical-save-case",
            toothNumber: "14-16",
            shade: "B1",
          }),
        ],
      },
      hierarchyResult: { invoiceAction: "needs_review" },
    });
    harness.render();

    const tooth = await screen.findByTestId("case-tooth-display");
    expect(tooth).toHaveTextContent("Tooth4, 14-16");
    expect(within(tooth).queryByText("A1")).not.toBeInTheDocument();
    expect(within(tooth).queryByText("B1")).not.toBeInTheDocument();
    expect(within(tooth).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(tooth).queryByRole("button")).not.toBeInTheDocument();
    expect(within(tooth).queryByRole("textbox")).not.toBeInTheDocument();
    expect(harness.patches).toEqual([]);
  });

  it("shows legacy case teeth without shade data and uses a neutral value when no teeth were recorded", async () => {
    makeHarness({
      detail: {
        ...AI_INTAKE_CASE,
        id: "legacy-case",
        restorations: [],
        teeth: "8, 9",
        shade: "A3.5",
      },
    }).render();
    const legacyTooth = await screen.findByTestId("case-tooth-display");
    expect(legacyTooth).toHaveTextContent("8, 9");
    expect(within(legacyTooth).queryByText("A3.5")).not.toBeInTheDocument();

    cleanup();
    makeHarness({
      detail: {
        ...AI_INTAKE_CASE,
        id: "empty-tooth-case",
        restorations: [
          restoration({
            id: "empty-restoration",
            caseId: "empty-tooth-case",
            toothNumber: "",
            restorationType: "Full Denture",
            arch: "upper",
            shade: "A2",
          }),
        ],
      },
    }).render();
    const emptyTooth = await screen.findByTestId("case-tooth-display");
    expect(emptyTooth).toHaveTextContent("Tooth—");
    expect(within(emptyTooth).queryByText("A2")).not.toBeInTheDocument();
  });

  it("keeps Custom Shade beside the read-only tooth value", async () => {
    makeHarness({ detail: { ...AI_INTAKE_CASE, id: "narrow-case" } }).render();

    const group = await screen.findByTestId("tooth-custom-shade");
    expect(group.className).toContain("flex-wrap");
    expect(within(group).getByTestId("case-tooth-display")).toHaveTextContent("Tooth4, 29");
    expect(within(group).getByRole("checkbox", { name: "Custom Shade" })).toBeInTheDocument();
  });
});

describe("Lab Slip practice details", () => {
  it("renders the linked practice's address and phone under its name", async () => {
    makeHarness({
      organizations: [
        {
          id: "prov-1",
          type: "provider",
          name: "Bright Dental",
          displayName: "Bright Dental",
        },
        {
          id: "prov-2",
          type: "provider",
          name: "Other Practice",
          displayName: "Other Practice",
          addressLine1: "999 Wrong Way",
          city: "Nowhere",
          state: "ZZ",
          zip: "00000",
          phone: "5559999999",
        },
      ],
      detail: {
        ...AI_INTAKE_CASE,
        id: "practice-case",
        providerOrganizationContact: {
          name: "Bright Dental",
          addressLine1: "120 Main St",
          addressLine2: "Suite 4",
          city: "Austin",
          state: "TX",
          zip: "78701",
          phone: "5125550143",
        },
      },
    }).render();

    const block = await screen.findByTestId("practice-details");
    await waitFor(() => {
      expect(within(block).getByText("Bright Dental")).toBeInTheDocument();
    });
    expect(within(block).getByText("120 Main St")).toBeInTheDocument();
    expect(within(block).getByText("Suite 4")).toBeInTheDocument();
    expect(within(block).getByText("Austin, TX 78701")).toBeInTheDocument();
    expect(within(block).getByText("(512) 555-0143")).toBeInTheDocument();
    // An unrelated practice's contact details must never appear here.
    expect(screen.queryByText("999 Wrong Way")).not.toBeInTheDocument();
    expect(screen.queryByText("Nowhere, ZZ 00000")).not.toBeInTheDocument();
  });

  it("says so plainly when the practice has no address or phone", async () => {
    makeHarness({
      organizations: [
        { id: "prov-1", type: "provider", name: "Bright Dental", displayName: "Bright Dental" },
      ],
      detail: {
        ...AI_INTAKE_CASE,
        id: "practice-blank-case",
        providerOrganizationContact: {
          name: "Bright Dental",
          addressLine1: null,
          city: null,
          state: null,
          zip: null,
          phone: null,
        },
      },
    }).render();

    const block = await screen.findByTestId("practice-details");
    await waitFor(() => {
      expect(within(block).getByText("Bright Dental")).toBeInTheDocument();
    });
    expect(
      within(block).getByText("No address or phone on file."),
    ).toBeInTheDocument();
  });
});

describe("Lab Slip header, routing and Step", () => {
  it.each([
    { dueTime: null, expected: "01/19/2026" },
    { dueTime: "13:30", expected: "01/19/2026 at 1:30 PM" },
  ])("keeps one due date below creation with due time $dueTime", async ({ dueTime, expected }) => {
    makeHarness({
      detail: { ...AI_INTAKE_CASE, dueDate: "2026-01-19", dueTime },
    }).render();

    const metadata = await screen.findByTestId("case-details-metadata");
    const dates = within(metadata).getByTestId("case-details-dates");
    expect(dates).toHaveClass("flex-col", "items-start");
    expect(Array.from(dates.children)).toEqual([
      within(metadata).getByTestId("case-details-date-created"),
      within(metadata).getByTestId("case-details-due-date"),
    ]);
    expect(within(metadata).getAllByText(/Due Date:/)).toHaveLength(1);
    expect(within(dates).getByText(expected)).toBeInTheDocument();
    expect(within(dates).getByText("01/15/2026")).toBeInTheDocument();
    expect(within(dates).queryByTestId("case-details-metadata-divider")).not.toBeInTheDocument();
    expect(within(metadata).getAllByTestId("case-details-metadata-divider")).toHaveLength(1);
    expect(within(metadata).getByRole("button", { name: "Mark rush" })).toBeEnabled();
  });

  it("puts case number and one Location control under the Case Details divider", async () => {
    makeHarness({
      locations: [
        { id: "station-received", code: "RECEIVED", name: "Received", status: "received" },
        { id: "station-model", code: "MODEL", name: "Model Room", status: "in_progress" },
      ],
      detail: { ...AI_INTAKE_CASE, id: "routing-case" },
    }).render();

    expect(await screen.findByText("Case #")).toBeInTheDocument();
    expect(screen.getByText("Case #").parentElement).toHaveTextContent("26-777");
    // Exactly one location control on the drawer; no separate confirmation.
    expect(screen.getAllByTestId("locate-case-select")).toHaveLength(1);
    expect(screen.queryByTestId("locate-case-submit")).not.toBeInTheDocument();
    expect(screen.getByTestId("case-header-location").closest("header")).toContainElement(
      screen.getByTestId("case-header-patient"),
    );
    expect(within(screen.getByTestId("case-detail-body")).queryByTestId("locate-case-select")).not.toBeInTheDocument();
    expect(screen.queryByText("Locate Case")).not.toBeInTheDocument();
    expect(screen.getAllByText("Location")).toHaveLength(1);

    const select = (await screen.findByTestId("locate-case-select")) as HTMLSelectElement;
    // Only the exact saved station is marked current; same-status siblings stay
    // selectable.
    await waitFor(() => {
      const current = Array.from(select.options).find((o) =>
        o.textContent?.includes("(current)"),
      );
      expect(current?.value).toBe("station-received");
      expect(current?.disabled).toBe(true);
    });
    expect(
      Array.from(select.options).find((o) => o.value === "station-model")?.disabled,
    ).toBe(false);
  });

  it("asks about the due date when a completed case is routed back to intake", async () => {
    const harness = makeHarness({
      locations: [
        { id: "station-received", code: "RECEIVED", name: "Received", status: "received" },
        { id: "station-complete", code: "COMPLETE", name: "Complete", status: "complete" },
      ],
      detail: {
        ...AI_INTAKE_CASE,
        id: "return-case",
        status: "complete",
        labLocationId: "station-complete",
        labLocationName: "Complete",
      },
    });
    harness.render();

    const select = (await screen.findByTestId("locate-case-select")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Received" });
    await waitFor(() => {
      expect(
        Array.from(select.options).some((o) => o.value === "station-received"),
      ).toBe(true);
    });
    fireEvent.change(select, { target: { value: "station-received" } });
    await waitFor(() => {
      expect(screen.getByTestId("return-wizard-dialog")).toBeInTheDocument();
    });
    expect(screen.getByTestId("return-wizard-dialog")).toHaveTextContent(/due date/i);
    expect(screen.queryByTestId("locate-case-submit")).not.toBeInTheDocument();
    expect(harness.patches).toEqual([]);
  });

  it("reports a routing failure and allows retry by selecting a station again", async () => {
    const harness = makeHarness({
      locations: [
        { id: "station-received", code: "RECEIVED", name: "Received", status: "received" },
        { id: "station-model", code: "MODEL", name: "Model Room", status: "in_progress" },
      ],
      detail: { ...AI_INTAKE_CASE, id: "route-error-case" },
      routeFailure: "Route refused.",
    });
    harness.render();

    const select = (await screen.findByTestId("locate-case-select")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Model Room" });
    fireEvent.change(select, { target: { value: "station-model" } });
    expect(await screen.findByText("Route refused.")).toBeInTheDocument();
    expect(screen.queryByText("Case located successfully.")).not.toBeInTheDocument();
    expect(select).toHaveValue("");
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: "station-model" } });
    await waitFor(() => {
      expect(
        harness.patches.filter(({ path }) => path.endsWith("/cases/route-error-case")),
      ).toHaveLength(2);
    });
    expect(screen.queryByTestId("locate-case-submit")).not.toBeInTheDocument();
  });

  it("shows Step beside Case Type for removable cases only", async () => {
    makeHarness({
      detail: {
        ...AI_INTAKE_CASE,
        id: "removable-case",
        step: "wax_setup",
        stepShade: "A2",
        restorations: [
          restoration({
            id: "rest-denture",
            caseId: "removable-case",
            toothNumber: "",
            restorationType: "full denture",
            material: "Acrylic",
            shade: "A2",
          }),
        ],
      },
    }).render();

    expect(await screen.findByText("Step")).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId("case-details-edit"));
    expect(screen.getByLabelText("Arch")).toBeInTheDocument();
    expect(screen.getByLabelText("Step")).toBeInTheDocument();
    expect(screen.getByText("Wax Setup Shade")).toBeInTheDocument();

    cleanup();
    makeHarness({ detail: { ...AI_INTAKE_CASE, id: "crown-case" } }).render();
    expect(await screen.findByTestId("case-tooth-display")).toBeInTheDocument();
    // Crown & bridge work has no removable production step.
    expect(screen.queryByText("Step")).not.toBeInTheDocument();
  });

  it("shows clinical entry fields for a case with no restoration rows", async () => {
    makeHarness({
      detail: {
        ...AI_INTAKE_CASE,
        id: "blank-clinical-case",
        restorations: [],
      },
    }).render();

    fireEvent.click(await screen.findByTestId("case-details-edit"));
    expect(screen.getByTestId("case-details-edit-form")).toBeInTheDocument();
    expect(screen.getByTestId("case-edit-patient-provider")).toHaveClass("rounded-lg", "border");
    expect(screen.getByTestId("case-edit-schedule-priority")).toHaveClass("rounded-lg", "border");
    expect(screen.getByTestId("case-edit-restoration-details")).toHaveClass("rounded-lg", "border");
    expect(await screen.findByText("Clinical Details")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Case Type…")).toBeInTheDocument();
    expect(screen.getByLabelText("Case Type")).toBeInTheDocument();
    expect(screen.getByLabelText("Case Material")).toBeInTheDocument();
    expect(screen.getByLabelText("Tooth Numbers")).toBeInTheDocument();
    expect(screen.getByText("Shade")).toBeInTheDocument();
    expect(screen.getByLabelText("Gingival Shade")).toBeInTheDocument();
  });

  it("saves clinical fields through one reconciliation call and reports the invoice outcome", async () => {
    const success = vi.spyOn(toast, "warning").mockImplementation(() => "toast-id");
    const harness = makeHarness({
      detail: { ...AI_INTAKE_CASE, id: "clinical-save-case" },
      hierarchyResult: { invoiceAction: "needs_review" },
    });
    harness.render();

    fireEvent.click(await screen.findByTestId("case-details-edit"));
    expect(screen.getByLabelText("Case Type")).toBeInTheDocument();
    expect(screen.getByLabelText("Subtype")).toBeInTheDocument();
    expect(screen.getByLabelText("Case Material")).toBeInTheDocument();
    const toothNumbers = await screen.findByLabelText("Tooth Numbers");
    fireEvent.change(toothNumbers, { target: { value: "4, 30" } });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(harness.patches.some(({ path }) =>
        path === "/cases/clinical-save-case/restorations/hierarchy",
      )).toBe(true);
    });
    const clinicalSave = harness.patches.find(({ path }) =>
      path === "/cases/clinical-save-case/restorations/hierarchy",
    );
    expect(clinicalSave?.body).toMatchObject({
      restorationType: "crown",
      material: "Zirconia",
      toothNumbers: ["4", "30"],
    });
    expect(clinicalSave?.body).not.toHaveProperty("shade");
    expect(
      (harness.patches.filter(({ path }) =>
        path === "/cases/clinical-save-case/restorations/hierarchy",
      )),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith(
        expect.stringContaining("reviewed invoice was flagged for review"),
      );
    });
    expect(success.mock.calls[0][0]).toContain("1 row repriced");
    expect(success.mock.calls[0][0]).toContain("1 manual price kept");
    expect(success.mock.calls[0][0]).toContain("1 row left unpriced");
  });
});
