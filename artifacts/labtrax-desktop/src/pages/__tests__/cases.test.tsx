/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CasesPage, { CaseDrawer, NewCaseModal } from "@/pages/cases";
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
            doctorName: "Dr. Smith",
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
      doctorName: "Dr. Smith",
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
    const invoiceTab = (await screen.findAllByRole("button")).find(
      (b) => b.textContent?.trim() === "Invoice",
    );
    expect(invoiceTab).toBeTruthy();
    fireEvent.click(invoiceTab!);

    // The payments section header and the recorded payment row render.
    expect(await screen.findByText(/Payments received/i)).toBeInTheDocument();
    expect(screen.getByText(/Check/)).toBeInTheDocument();
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
    fireEvent.change(screen.getByPlaceholderText("Dr. Smith"), {
      target: { value: "Kanesha Cole" },
    });

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
// `cases_filters_v2` so they survive opening/closing the case-detail drawer
// (which keeps the page mounted on /cases), but an unmount — i.e. navigating
// to another section entirely — must clear the persisted entry so the list
// reloads unfiltered next time. This dual behavior has no other coverage.
const CASES_FILTER_STORAGE_KEY = "cases_filters_v2";

function seedCasesFilters(overrides: Record<string, unknown> = {}) {
  sessionStorage.setItem(
    CASES_FILTER_STORAGE_KEY,
    JSON.stringify({
      search: "",
      statusFilter: "all",
      priorityFilter: "all",
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
    seedCasesFilters({ search: "Jane", statusFilter: "received" });

    const Wrapper = makeAuthWrapper("/cases");
    const { unmount } = render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // While mounted the entry exists (the page re-persists it on mount).
    expect(sessionStorage.getItem(CASES_FILTER_STORAGE_KEY)).not.toBeNull();

    // Unmounting the page (route change to another section) clears it.
    unmount();
    expect(sessionStorage.getItem(CASES_FILTER_STORAGE_KEY)).toBeNull();
  });

  it("keeps the persisted filters when a case drawer opens (page stays mounted)", () => {
    seedCasesFilters({ search: "Jane", statusFilter: "received" });

    const fakeCase = {
      id: "case-1",
      caseNumber: "26-1",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      doctorName: "Dr. Smith",
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
    // re-hydrate every control from `cases_filters_v2`, not just the search.
    seedCasesFilters({
      search: "Jane",
      statusFilter: "in_porcelain",
      priorityFilter: "rush",
      dateRangeFilter: "30",
    });

    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    // Text search is restored into the toolbar input.
    const searchInput = screen.getByPlaceholderText(
      "Search case #, doctor, patient…",
    ) as HTMLInputElement;
    expect(searchInput.value).toBe("Jane");

    // Each filter <select> reflects its persisted value. Identify them by the
    // option set they own so the assertion doesn't depend on DOM order.
    const selects = Array.from(
      document.querySelectorAll("select"),
    ) as HTMLSelectElement[];

    const statusSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === "in_porcelain"),
    );
    const prioritySelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === "rush"),
    );
    const dateSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === "30"),
    );

    expect(statusSelect?.value).toBe("in_porcelain");
    expect(prioritySelect?.value).toBe("rush");
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
      expect(persisted.statusFilter).toBe("all");
      expect(persisted.priorityFilter).toBe("all");
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
      label: "Dr. Smith",
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
    expect(screen.getByText(/Dr\. Smith/)).toBeInTheDocument();

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
