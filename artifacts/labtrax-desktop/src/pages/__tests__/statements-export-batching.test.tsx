/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import StatementsPage from "@/pages/statements";
import { makeAuthWrapper } from "../../__tests__/test-utils";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));

const toastCalls: Array<{ title?: string; description?: string }> = [];
vi.mock("@/hooks/use-toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-toast")>();
  return {
    ...actual,
    toast: (options: { title?: string; description?: string }) => {
      toastCalls.push(options);
      return { id: "test-toast", dismiss: () => {}, update: () => {} };
    },
  };
});

/** 250 practices — more than two bounded export batches. */
const summaries = Array.from({ length: 250 }, (_, index) => ({
  practiceId: `practice-${index + 1}`,
  practiceName: `Practice ${String(index + 1).padStart(3, "0")}`,
  billingEmail: null,
  phone: null,
  openInvoiceCount: 1,
  openInvoiceTotal: index + 1,
  unpaidStatements: [],
  totalOpenBalance: index + 1,
  overdueBalance: 0,
  invoiceCount: 1,
  totalBilled: index + 1,
  totalPaid: 0,
  openBalance: index + 1,
  oldestOpen: null,
}));

let summaryRequests: URL[] = [];
let failAtOffset: number | null = null;
let exportGate: { promise: Promise<void>; release: () => void } | null = null;
let downloadedBlobs: Blob[] = [];

function makeGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

function exportRequests() {
  return summaryRequests.filter((url) => url.searchParams.get("limit") === "100");
}

/** Mirrors the server's practice-name search so batches stay consistent. */
function matchingSummaries(search: string | null) {
  const term = (search ?? "").trim().toLowerCase();
  if (!term) return summaries;
  return summaries.filter((row) => row.practiceName.toLowerCase().includes(term));
}

beforeEach(() => {
  summaryRequests = [];
  downloadedBlobs = [];
  failAtOffset = null;
  exportGate = null;
  toastCalls.length = 0;
  localStorage.setItem("labtrax_finance_org_v1", "lab-1");
  (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = (
    blob: Blob,
  ) => {
    downloadedBlobs.push(blob);
    return "blob:statements-export";
  };
  (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      "http://localhost",
    );
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.pathname.endsWith("/statements/account-summaries")) {
      summaryRequests.push(url);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (limit === 100) {
        if (exportGate) {
          const gate = exportGate;
          exportGate = null;
          await gate.promise;
        }
        if (failAtOffset !== null && offset === failAtOffset) {
          return json({ error: "Statement export timed out." }, 500);
        }
      }
      const matching = matchingSummaries(url.searchParams.get("search"));
      const rows = matching.slice(offset, offset + limit);
      return json({
        rows,
        total: matching.length,
        limit,
        offset,
        hasMore: offset + rows.length < matching.length,
        totals: { billed: 1, paid: 0, open: 1, overdue: 0 },
      });
    }
    if (url.pathname.endsWith("/organizations")) {
      return json([{ id: "lab-1", name: "Lab One", type: "lab" }]);
    }
    if (url.pathname.endsWith("/statement-schedule")) return json({});
    if (url.pathname.endsWith("/statement-runs")) return json([]);
    if (url.pathname.endsWith("/admin/templates/statement-email")) return json({});
    return json([]);
  }));
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function exportButton() {
  return screen.getByRole("button", { name: /export/i });
}

async function renderStatements() {
  const Wrapper = makeAuthWrapper("/statements", {
    user: {
      id: "user-1",
      username: "admin",
      role: "admin",
      userType: "lab",
    } as never,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(<Wrapper><StatementsPage /></Wrapper>);
  await screen.findByText("Practice 001");
}

describe("statements summary CSV export on a large history", () => {
  it("walks bounded batches and writes every matching row in order", async () => {
    await renderStatements();
    // Only the first batch is on screen.
    expect(screen.queryByText("Practice 011")).toBeNull();

    fireEvent.click(exportButton());
    await waitFor(() => expect(downloadedBlobs).toHaveLength(1));

    expect(
      exportRequests().map((url) => url.searchParams.get("offset")),
    ).toEqual(["0", "100", "200"]);

    const csv = await downloadedBlobs[0].text();
    const lines = csv.replace(/^\uFEFF/, "").split("\n");
    expect(lines).toHaveLength(251);
    expect(lines[0]).toContain("Practice,Email,Open invoices");
    expect(lines[1]).toContain("Practice 001");
    expect(lines[100]).toContain("Practice 100");
    expect(lines[250]).toContain("Practice 250");
  });

  it("keeps the export complete under an active filter", async () => {
    await renderStatements();
    // "1" matches far more practices than fit in one batch.
    const matching = matchingSummaries("1");
    expect(matching.length).toBeGreaterThan(100);

    fireEvent.change(screen.getByPlaceholderText("Search practice…"), {
      target: { value: "1" },
    });
    await waitFor(() => {
      expect(summaryRequests.at(-1)?.searchParams.get("search")).toBe("1");
    });
    await screen.findByText(matching[0].practiceName);

    fireEvent.click(exportButton());
    await waitFor(() => expect(downloadedBlobs).toHaveLength(1));

    // Every export batch carries the filter the table is showing.
    expect(exportRequests()).toHaveLength(Math.ceil(matching.length / 100));
    for (const url of exportRequests()) {
      expect(url.searchParams.get("search")).toBe("1");
      expect(url.searchParams.get("aging")).toBe("all");
    }
    const csv = await downloadedBlobs[0].text();
    // Header plus every matching practice — not just the loaded batch.
    expect(csv.replace(/^\uFEFF/, "").split("\n")).toHaveLength(
      matching.length + 1,
    );
  });

  it("shows a working state while the export runs", async () => {
    await renderStatements();
    exportGate = makeGate();
    const gate = exportGate;

    fireEvent.click(exportButton());
    await waitFor(() => expect(exportButton()).toBeDisabled());
    expect(exportButton()).toHaveAttribute("aria-busy", "true");
    expect(exportButton().textContent).toContain("Exporting");
    // A second click while working must not start a competing export.
    fireEvent.click(exportButton());

    gate.release();
    await waitFor(() => expect(downloadedBlobs).toHaveLength(1));
    await waitFor(() => expect(exportButton()).not.toBeDisabled());
    expect(exportRequests()).toHaveLength(3);
  });

  it("reports a failed batch instead of downloading a truncated file", async () => {
    await renderStatements();
    failAtOffset = 100;

    fireEvent.click(exportButton());
    await waitFor(() => expect(toastCalls).toHaveLength(1));

    expect(toastCalls[0].title).toBe("Export failed");
    expect(downloadedBlobs).toHaveLength(0);
    await waitFor(() => expect(exportButton()).not.toBeDisabled());
  });
});
