/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CasesPage from "@/pages/cases";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const makeCase = (id: string, caseNumber = id) => ({
  id,
  caseNumber,
  patientFirstName: "Work",
  patientLastName: "List",
  doctorName: "Dr. Query",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  totalPrice: "0.00",
  labOrganizationId: "lab-1",
});

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

function renderPage(path = "/cases") {
  const Wrapper = makeAuthWrapper(path);
  return render(
    <Wrapper>
      <AiPanelContext.Provider value={{ openPanel: () => {} }}>
        <CasesPage />
      </AiPanelContext.Provider>
    </Wrapper>,
  );
}

describe("Cases worklist on demand", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("requests ten recent cases initially and keeps a half-complete custom range inert", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/organizations")) return json([]);
      if (url.includes("/cases/worklist")) return json({ rows: [], total: 0, page: 1, pageSize: 10, hasMore: false });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    fireEvent.change(screen.getByRole("combobox", { name: "Date" }), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-01-01" } });
    await waitFor(() => {
      const initialUrl = fetchMock.mock.calls
        .map(([input]) => String(input))
        .find((url) => url.includes("/cases/worklist"));
      expect(initialUrl).toContain("pageSize=10");
      expect(initialUrl).not.toContain("receivedStart");
    });
    expect(await screen.findByText("No cases yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByTestId("cases-status-filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Received$/ }));
    await waitFor(() => {
      const requestUrl = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/cases/worklist")).at(-1);
      expect(requestUrl).toBeTruthy();
      expect(requestUrl).not.toContain("createdStart");
      expect(requestUrl).not.toContain("createdEnd");
    });
  });

  it("uses received-date parameters for Today and complete custom ranges", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/organizations")) return json([]);
      if (url.includes("/cases/worklist"))
        return json({ rows: [], total: 0, page: 1, pageSize: 50, hasMore: false });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const dateFilter = screen.getByRole("combobox", { name: "Date" });
    fireEvent.change(dateFilter, { target: { value: "today" } });
    await waitFor(() => {
      const requestUrl = fetchMock.mock.calls
        .map(([input]) => String(input))
        .find((url) => url.includes("/cases/worklist") && url.includes("receivedStart="));
      expect(requestUrl).toBeTruthy();
      expect(requestUrl).toContain("receivedStart=");
      expect(requestUrl).toContain("receivedEnd=");
      expect(requestUrl).not.toContain("createdStart");
      expect(requestUrl).not.toContain("createdEnd");
    });

    fireEvent.change(dateFilter, { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2025-01-10" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2025-01-12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      const requestUrls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.includes("/cases/worklist"));
      const requestUrl = requestUrls.at(-1);
      expect(requestUrl).toContain("receivedStart=2025-01-10");
      expect(requestUrl).toContain("receivedEnd=2025-01-12");
      expect(requestUrl).not.toContain("createdStart");
      expect(requestUrl).not.toContain("createdEnd");
    });
  });

  it("debounces search and reset prevents the stale query from remaining visible", async () => {
    let resolveWorklist!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cases/worklist")) {
        if (!new URL(url).searchParams.has("search")) {
          return json({ rows: [], total: 0, page: 1, pageSize: 10, hasMore: false });
        }
        return await new Promise<Response>((resolve) => { resolveWorklist = resolve; });
      }
      if (url.includes("/organizations") || url.includes("/locations")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "old query" } });
    await waitFor(() => expect(resolveWorklist).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: /Reset filters/i }));
    resolveWorklist(json({ rows: [makeCase("stale")], total: 1, page: 1, pageSize: 50, hasMore: false }));
    await waitFor(() => expect(screen.getByText("No cases yet.")).toBeInTheDocument());
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
  });

  it("automatically searches a full patient name promptly without Enter", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/cases/worklist")) {
        const search = url.searchParams.get("search");
        return json({
          rows: search === "Kenneth" ? [makeCase("kenneth-case", "KEN-101")] : [],
          total: search === "Kenneth" ? 1 : 0,
          page: 1,
          pageSize: 50,
          hasMore: false,
        });
      }
      if (url.pathname.includes("/organizations") || url.pathname.includes("/locations")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "Kenneth" } });
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    expect(await screen.findByText("KEN-101")).toBeInTheDocument();
    const worklistRequests = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/cases/worklist"));
    expect(worklistRequests).toHaveLength(2);
    expect(worklistRequests[1]).toContain("search=Kenneth");
  });

  it("keeps only the visible query when responses finish out of order", async () => {
    const resolvers = new Map<string, (response: Response) => void>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/cases/worklist")) {
        const term = url.searchParams.get("search") ?? "";
        return await new Promise<Response>((resolve) => resolvers.set(term, resolve));
      }
      if (url.pathname.includes("/organizations") || url.pathname.includes("/locations")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    const input = screen.getByPlaceholderText(/Search case #/i);

    fireEvent.change(input, { target: { value: "Kenneth" } });
    await waitFor(() => expect(resolvers.has("Kenneth")).toBe(true));
    fireEvent.change(input, { target: { value: "Ken" } });
    expect(screen.queryByText("No cases match the current filters.")).not.toBeInTheDocument();
    await waitFor(() => expect(resolvers.has("Ken")).toBe(true));

    resolvers.get("Ken")!(json({ rows: [makeCase("current", "KEN-CURRENT")], total: 1, salesTotal: "20.00", page: 1, pageSize: 50, hasMore: false }));
    expect(await screen.findByText("KEN-CURRENT")).toBeInTheDocument();
    expect(screen.getByTestId("filtered-case-sales-total")).toHaveTextContent("$20.00");
    resolvers.get("Kenneth")!(json({ rows: [makeCase("old", "KEN-OLD")], total: 1, salesTotal: "999.00", page: 1, pageSize: 50, hasMore: false }));

    await waitFor(() => expect(screen.getByText("KEN-CURRENT")).toBeInTheDocument());
    expect(screen.queryByText("KEN-OLD")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 1 loaded")).toBeInTheDocument();
    expect(screen.getByTestId("filtered-case-sales-total")).toHaveTextContent("$20.00");
    expect(screen.queryByText("$999.00")).not.toBeInTheDocument();
  });

  it("keeps current results when surrounding whitespace does not change the normalized query", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/cases/worklist")) {
        return json({ rows: [makeCase("kenneth", "KEN-WHITESPACE")], total: 1, page: 1, pageSize: 50, hasMore: false });
      }
      if (url.pathname.includes("/organizations") || url.pathname.includes("/locations")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    const input = screen.getByPlaceholderText(/Search case #/i);

    fireEvent.change(input, { target: { value: "Kenneth" } });
    expect(await screen.findByText("KEN-WHITESPACE")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "  Kenneth  " } });

    expect(screen.getByText("KEN-WHITESPACE")).toBeInTheDocument();
    expect(screen.getByText("1 of 1 loaded")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fetchMock.mock.calls.filter(([request]) => String(request).includes("/cases/worklist"))).toHaveLength(2);
  });

  it("shows the server total and appends the next bounded page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/cases/worklist")) {
        if (url.searchParams.has("receivedStart")) return json({ rows: [makeCase("custom-case", "RANGE")], total: 1, salesTotal: "50.00", page: 1, pageSize: 50, hasMore: false });
        const page = Number(url.searchParams.get("page"));
        return page === 1
          ? json({ rows: [makeCase("case-one", "WL-ONE")], total: 2, salesTotal: "1550.75", page: 1, pageSize: 50, hasMore: true })
          : json({ rows: [makeCase("case-two", "WL-TWO")], total: 2, salesTotal: "1550.75", page: 2, pageSize: 50, hasMore: false });
      }
      if (url.pathname.includes("/organizations") || url.pathname.includes("/locations")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    fireEvent.click(screen.getByTestId("cases-status-filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Received$/ }));
    expect(await screen.findByText("WL-ONE")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 loaded")).toBeInTheDocument();
    expect(screen.getByTestId("filtered-case-sales-total")).toHaveTextContent(
      "Filtered sales total$1,550.75",
    );
    fireEvent.click(screen.getByRole("button", { name: /Load more \(1 of 2\)/i }));
    expect(await screen.findByText("WL-TWO")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load more/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("filtered-case-sales-total")).toHaveTextContent("$1,550.75");
    const beforeRange = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "5/5/2025" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "5/10/2025" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("RANGE")).toBeInTheDocument();
    expect(screen.queryByText("WL-TWO")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 1 loaded")).toBeInTheDocument();
    expect(screen.getByTestId("filtered-case-sales-total")).toHaveTextContent("$50.00");
    const rangeRequests = fetchMock.mock.calls.slice(beforeRange).map(([input]) => new URL(String(input), "http://localhost")).filter(url => url.pathname.endsWith("/cases/worklist"));
    expect(rangeRequests.length).toBeGreaterThan(0);
    expect(rangeRequests.every(url => url.searchParams.get("page") === "1" && url.searchParams.get("status") === "received")).toBe(true);
  });

  it("requests page one atomically when filters, search, or reset change criteria after loading more", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/cases/worklist")) {
        const page = Number(url.searchParams.get("page"));
        return json({
          rows: [makeCase(`${url.searchParams.toString()}-${page}`, `PAGE-${page}`)],
          total: 2,
          page,
          pageSize: 50,
          hasMore: page === 1,
        });
      }
      if (url.pathname.includes("/organizations") || url.pathname.includes("/locations")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fireEvent.click(screen.getByTestId("cases-status-filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Received$/ }));
    expect(await screen.findByText("PAGE-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Load more \(1 of 2\)/i }));
    await waitFor(() => {
      const requests = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname.endsWith("/cases/worklist"));
      expect(requests.some((url) => url.searchParams.get("status") === "received" && url.searchParams.get("page") === "2")).toBe(true);
    });

    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "Kenneth" } });
    await waitFor(() => {
      const searchRequests = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname.endsWith("/cases/worklist") && url.searchParams.get("search") === "Kenneth");
      expect(searchRequests.length).toBeGreaterThan(0);
      expect(searchRequests.every((url) => url.searchParams.get("page") === "1")).toBe(true);
    });

    const requestCountBeforeClearingSearch = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "" } });
    await waitFor(() => {
      const returnedRequests = fetchMock.mock.calls
        .slice(requestCountBeforeClearingSearch)
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname.endsWith("/cases/worklist")
          && url.searchParams.get("status") === "received"
          && !url.searchParams.has("search"));
      expect(returnedRequests.length).toBeGreaterThan(0);
      expect(returnedRequests.every((url) => url.searchParams.get("page") === "1")).toBe(true);
    });

    fireEvent.click(await screen.findByRole("button", { name: /Load more \(1 of 2\)/i }));
    await waitFor(() => {
      const returnedPageTwo = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .some((url) => url.pathname.endsWith("/cases/worklist")
          && url.searchParams.get("status") === "received"
          && !url.searchParams.has("search")
          && url.searchParams.get("page") === "2");
      expect(returnedPageTwo).toBe(true);
    });

    const requestCountBeforeReset = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /Reset filters/i }));
    await waitFor(() => {
      const resetRequests = fetchMock.mock.calls
        .slice(requestCountBeforeReset)
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname.endsWith("/cases/worklist"));
      expect(resetRequests.length).toBeGreaterThan(0);
      expect(resetRequests.every((url) => !url.searchParams.has("status")
        && url.searchParams.get("page") === "1")).toBe(true);
    });
  });

  it("clears the sales amount while changing filters and removes it on reset", async () => {
    let resolveWorklist!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cases/worklist")) {
        if (!new URL(url).searchParams.has("search")) {
          return json({ rows: [], total: 0, salesTotal: "0.00", page: 1, pageSize: 10, hasMore: false });
        }
        return await new Promise<Response>((resolve) => { resolveWorklist = resolve; });
      }
      if (url.includes("/organizations") || url.includes("/locations")) return json([]);
      return json({});
    }));
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "sales" } });
    await waitFor(() => expect(resolveWorklist).toBeTypeOf("function"));
    expect(screen.getByTestId("filtered-case-sales-total")).toHaveTextContent("—");
    resolveWorklist(json({
      rows: [makeCase("sales-case", "SALES-1")],
      total: 1,
      salesTotal: "88.00",
      page: 1,
      pageSize: 50,
      hasMore: false,
    }));
    expect(await screen.findByText("SALES-1")).toBeInTheDocument();
    expect(screen.getByTestId("filtered-case-sales-total")).toHaveTextContent("$88.00");
    fireEvent.click(screen.getByRole("button", { name: /Reset filters/i }));
    expect(screen.queryByTestId("filtered-case-sales-total")).not.toBeInTheDocument();
  });

  it("does not show a sales total for an empty successful result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cases/worklist")) {
        return json({ rows: [], total: 0, salesTotal: "0.00", page: 1, pageSize: 50, hasMore: false });
      }
      if (url.includes("/organizations") || url.includes("/locations")) return json([]);
      return json({});
    }));
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "no matches" } });
    expect(await screen.findByText("No cases match the current filters.")).toBeInTheDocument();
    expect(screen.queryByTestId("filtered-case-sales-total")).not.toBeInTheDocument();
  });

  it("does not show a sales total after a failed search", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cases/worklist")) {
        return new Response(JSON.stringify({ message: "Search failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/organizations") || url.includes("/locations")) return json([]);
      return json({});
    }));
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "failure" } });
    await waitFor(() => expect(screen.queryByText("Searching cases…")).not.toBeInTheDocument());
    expect(screen.queryByTestId("filtered-case-sales-total")).not.toBeInTheDocument();
  });

  it("refreshes the recent list and then the active filtered query", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cases/worklist")) return json({ rows: [], total: 0, page: 1, pageSize: 50, hasMore: false });
      if (url.includes("/organizations") || url.includes("/locations")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    const refresh = screen.getByRole("button", { name: "Refresh" });
    await screen.findByText("No cases yet.");
    await waitFor(() => expect(refresh).not.toBeDisabled());
    fireEvent.click(refresh);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/cases/worklist"))).toHaveLength(2));
    fireEvent.click(screen.getByTestId("cases-priority-filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Rush$/ }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/cases/worklist"))).toHaveLength(3));
    await waitFor(() => expect(refresh).not.toBeDisabled());
    fireEvent.click(refresh);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/cases/worklist"))).toHaveLength(4));
  });

  it("loads an imported batch by its explicit case IDs", async () => {
    sessionStorage.setItem("cases_itero_batch_v1", JSON.stringify({
      batchId: "batch-1",
      caseIds: ["import-1", "import-2"],
      importedAt: "2025-01-01T00:00:00.000Z",
      label: "Two imported cases",
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cases/worklist")) return json({ rows: [], total: 0, page: 1, pageSize: 50, hasMore: false });
      if (url.includes("/organizations") || url.includes("/locations")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => {
      const requestUrl = fetchMock.mock.calls
        .map(([input]) => String(input))
        .find((url) => url.includes("/cases/worklist") && url.includes("caseId=import-1"));
      expect(requestUrl).toContain("caseId=import-1");
      expect(requestUrl).toContain("caseId=import-2");
    });
    expect(screen.getByText(/Filtered to iTero import session/i)).toBeInTheDocument();
  });

  it("opens a barcode lookup while the recent worklist is loaded", async () => {
    const found = makeCase("barcode-case", "BARCODE-CASE");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/organizations")) return json([{ id: "lab-1", type: "lab", name: "Lab" }]);
      if (url.includes("/cases/barcode/PAN-42")) return json({ case: found });
      if (url.includes("/cases/barcode-case")) return json(found);
      if (url.includes("/locations")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([request]) => String(request).includes("/organizations"))).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: "Scan barcode" }));
    const input = screen.getByPlaceholderText("Scan or type barcode…");
    fireEvent.change(input, { target: { value: "PAN-42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([request]) => String(request).includes("/cases/barcode/PAN-42"))).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([request]) => String(request).includes("/cases/worklist"))).toBe(true);
    expect((await screen.findAllByText(/BARCODE-CASE/)).length).toBeGreaterThan(0);
  });

  it("select all selects only rows returned by the active worklist", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cases/worklist")) {
        return json({ rows: [makeCase("visible-1", "VISIBLE-1"), makeCase("visible-2", "VISIBLE-2")], total: 20, page: 1, pageSize: 50, hasMore: true });
      }
      if (url.includes("/organizations") || url.includes("/locations")) return json([]);
      return json({});
    }));
    renderPage();
    fireEvent.click(screen.getByTestId("cases-status-filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Received$/ }));
    await screen.findByText("VISIBLE-1");
    fireEvent.click(screen.getByLabelText("Select all cases"));
    expect(screen.getByText("2 cases selected")).toBeInTheDocument();
  });
});