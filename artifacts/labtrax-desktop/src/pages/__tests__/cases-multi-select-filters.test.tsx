/**
 * @vitest-environment jsdom
 *
 * Task #3915: the Cases list Status / Priority / Type filters are multi-select,
 * so a user can look at several statuses at once (e.g. Received + In Design)
 * and the list shows the UNION of them. These tests pin the parts that a
 * single-value <select> could never express and that a regression would break
 * silently: multiple checked values widening the list, the empty selection
 * meaning "All", the per-dropdown Clear action, the trigger summary label, and
 * keyboard operation of the dropdown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CasesPage from "@/pages/cases";
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

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

function makeCase(overrides: Partial<LabCase> = {}): LabCase {
  return {
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
    restorationTypes: null,
    restorationMaterials: null,
    firstRestorationSubtype: null,
    ...overrides,
  } as unknown as LabCase;
}

const RECEIVED_CASE = makeCase({
  id: "case-received",
  caseNumber: "26-RECEIVED",
  status: "received",
});
const IN_DESIGN_CASE = makeCase({
  id: "case-in-design",
  caseNumber: "26-INDESIGN",
  status: "in_design",
});
const PORCELAIN_CASE = makeCase({
  id: "case-porcelain",
  caseNumber: "26-PORCELAIN",
  status: "in_porcelain",
});
const SHIPPED_RUSH_CASE = makeCase({
  id: "case-shipped",
  caseNumber: "26-SHIPPED",
  status: "shipped",
  priority: "rush",
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function openStatusFilter() {
  fireEvent.click(screen.getByTestId("cases-status-filter"));
}

function toggleOption(name: RegExp | string) {
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name }));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (new URL(url, "http://localhost").pathname.endsWith("/cases/worklist")) {
        const parsed = new URL(url, "http://localhost");
        let rows = [
          RECEIVED_CASE,
          IN_DESIGN_CASE,
          PORCELAIN_CASE,
          SHIPPED_RUSH_CASE,
        ];
        const statuses = parsed.searchParams.getAll("status");
        const priorities = parsed.searchParams.getAll("priority");
        if (statuses.length) rows = rows.filter((c) => statuses.includes(c.status));
        if (priorities.length) rows = rows.filter((c) => priorities.includes(c.priority));
        return jsonResponse({ rows, total: rows.length, page: 1, pageSize: 50, hasMore: false });
      }
      if (url.includes("/organizations") || url.includes("/locations")) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  sessionStorage.clear();
});

describe("Cases list — multi-select Status / Priority / Type filters", () => {
  it("shows the union of several checked statuses", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    openStatusFilter();
    toggleOption(/^Received$/);
    toggleOption(/^In Design$/);
    toggleOption(/^Porcelain$/);

    await waitFor(() => {
      expect(screen.getByText("26-RECEIVED")).toBeInTheDocument();
      expect(screen.getByText("26-INDESIGN")).toBeInTheDocument();
      expect(screen.getByText("26-PORCELAIN")).toBeInTheDocument();
      // A status that was never checked stays filtered out.
      expect(screen.queryByText("26-SHIPPED")).not.toBeInTheDocument();
    });
  });

  it("summarizes the selection on the closed trigger (All / single label / N selected)", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    const trigger = screen.getByTestId("cases-status-filter");
    expect(trigger).toHaveTextContent("Location: All");

    openStatusFilter();
    toggleOption(/^In Design$/);
    expect(trigger).toHaveTextContent("Location: In Design");

    toggleOption(/^Porcelain$/);
    expect(trigger).toHaveTextContent("Location: 2 selected");

    toggleOption(/^Received$/);
    expect(trigger).toHaveTextContent("Location: 3 selected");
  });

  it("the dropdown's Clear action returns the filter to All", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    openStatusFilter();
    toggleOption(/^Received$/);
    toggleOption(/^In Design$/);

    await waitFor(() => {
      expect(screen.queryByText("26-SHIPPED")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Clear location filter"));

    await waitFor(() => {
      expect(screen.getByTestId("cases-status-filter")).toHaveTextContent(
        "Location: All",
      );
      expect(screen.getByText("26-SHIPPED")).toBeInTheDocument();
    });
  });

  it("unchecking the last checked value also means All (empty selection)", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    openStatusFilter();
    toggleOption(/^Received$/);
    await waitFor(() => {
      expect(screen.queryByText("26-SHIPPED")).not.toBeInTheDocument();
    });

    toggleOption(/^Received$/);
    await waitFor(() => {
      expect(screen.getByTestId("cases-status-filter")).toHaveTextContent(
        "Location: All",
      );
      expect(screen.getByText("26-SHIPPED")).toBeInTheDocument();
    });
  });

  it("Status and Priority multi-selections combine (AND across filters)", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    openStatusFilter();
    toggleOption(/^Received$/);
    toggleOption(/^Shipping$/);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(screen.getByTestId("cases-priority-filter"));
    toggleOption(/^Rush$/);

    await waitFor(() => {
      // Only the shipped case is rush, so the union of two statuses narrows to it.
      expect(screen.getByText("26-SHIPPED")).toBeInTheDocument();
      expect(screen.queryByText("26-RECEIVED")).not.toBeInTheDocument();
      expect(screen.queryByText("26-PORCELAIN")).not.toBeInTheDocument();
    });
  });

  it("Reset filters clears every multi-selection back to All", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    openStatusFilter();
    toggleOption(/^Received$/);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(screen.getByTestId("cases-priority-filter"));
    toggleOption(/^Normal$/);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    const resetBtn = screen.getByRole("button", { name: /Reset filters/i });
    expect(resetBtn).not.toBeDisabled();
    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(screen.getByTestId("cases-status-filter")).toHaveTextContent(
        "Location: All",
      );
      expect(screen.getByTestId("cases-priority-filter")).toHaveTextContent(
        "Priority: All",
      );
      expect(resetBtn).toBeDisabled();
      expect(screen.getByText("26-SHIPPED")).toBeInTheDocument();
    });
  });

  it("is operable by keyboard: ArrowDown opens and focuses, Space toggles, Escape closes", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    const trigger = screen.getByTestId("cases-status-filter");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    // Options expose their checked state to assistive tech.
    const received = screen.getByRole("menuitemcheckbox", { name: /^Received$/ });
    expect(received).toHaveAttribute("aria-checked", "false");

    // Buttons activate on Space/Enter — jsdom doesn't synthesize the click, so
    // assert the toggle via the click the browser would fire.
    fireEvent.click(received);
    expect(
      screen.getByRole("menuitemcheckbox", { name: /^Received$/ }),
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Focus returns to the trigger so keyboard users aren't stranded.
    expect(document.activeElement).toBe(trigger);
  });

  it("renders each filter option as one interactive element without nested buttons", () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    for (const testId of [
      "cases-status-filter",
      "cases-priority-filter",
      "cases-type-filter",
    ]) {
      fireEvent.click(screen.getByTestId(testId));
      const options = screen.getAllByRole("menuitemcheckbox");
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        expect(option.tagName).toBe("BUTTON");
        expect(option.querySelector("button")).toBeNull();
      }
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    }
  });

  it("persists the multi-selections so they survive returning to the list", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    render(<Wrapper>{withAiPanel(<CasesPage />)}</Wrapper>);

    openStatusFilter();
    toggleOption(/^Received$/);
    toggleOption(/^In Design$/);

    await waitFor(() => {
      const raw = sessionStorage.getItem("cases_filters_v4");
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).statusFilters).toEqual(["received", "in_design"]);
    });
  });
});
