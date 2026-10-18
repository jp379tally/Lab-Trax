/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import RegisterPage from "@/pages/finance/register";
import type { BankAccount, BankTransaction } from "@/lib/types";
import { makeAuthWrapper } from "../../../__tests__/test-utils";

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

const ACCOUNT: BankAccount = {
  id: "acct-1",
  name: "Operating",
  accountType: "checking",
  bookBalance: "100",
  clearedBalance: "100",
  unreconciledBalance: "0",
} as unknown as BankAccount;

vi.mock("@/components/finance/FinanceShell", () => ({
  FinanceShell: ({
    children,
  }: {
    children: (ctx: {
      organizationId: string;
      accountId: string | null;
      accounts: BankAccount[];
    }) => ReactNode;
  }) => <>{children({ organizationId: "org-1", accountId: "acct-1", accounts: [ACCOUNT] })}</>,
}));

/** 250 transactions — more than two bounded export batches. */
const TXNS: BankTransaction[] = Array.from({ length: 250 }, (_, index) => ({
  id: `t${index + 1}`,
  labOrganizationId: "org-1",
  bankAccountId: "acct-1",
  txnDate: "2026-06-01T00:00:00.000Z",
  type: "other",
  checkNumber: null,
  payee: `Payee ${String(index + 1).padStart(3, "0")}`,
  vendorId: null,
  memo: null,
  categoryId: null,
  debitAmount: "10",
  creditAmount: "0",
  netAmount: "-10",
  cleared: false,
  reconciled: false,
  status: "posted",
  source: "manual",
  runningBalance: "90",
  invoices: [],
}) as BankTransaction);

/** Every /finance/transactions request, newest last. */
let txnRequests: URL[] = [];
/** Offset whose request should fail, simulating a mid-export server error. */
let failAtOffset: number | null = null;
/** When set, the first export batch waits until the test releases it. */
let exportGate: { promise: Promise<void>; release: () => void } | null = null;
/** CSV blobs handed to URL.createObjectURL. */
let downloadedBlobs: Blob[] = [];

function makeGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

function exportRequests() {
  return txnRequests.filter((url) => url.searchParams.get("limit") === "100");
}

beforeEach(() => {
  txnRequests = [];
  downloadedBlobs = [];
  failAtOffset = null;
  exportGate = null;
  toastCalls.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = (
    blob: Blob,
  ) => {
    downloadedBlobs.push(blob);
    return "blob:register-export";
  };
  (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
        "http://localhost",
      );
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname.endsWith("/finance/transactions")) {
        txnRequests.push(url);
        const limit = Number(url.searchParams.get("limit") ?? 10);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (limit === 100) {
          if (exportGate) {
            const gate = exportGate;
            exportGate = null;
            await gate.promise;
          }
          if (failAtOffset !== null && offset === failAtOffset) {
            return json({ error: "Register export timed out." }, 500);
          }
        }
        const rows = TXNS.slice(offset, offset + limit);
        return json({
          rows,
          total: TXNS.length,
          limit,
          offset,
          hasMore: offset + rows.length < TXNS.length,
        });
      }
      return json([]);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function exportButton() {
  return screen.getByRole("button", { name: /export/i });
}

async function renderRegister() {
  const Wrapper = makeAuthWrapper("/finance/register");
  render(<RegisterPage />, { wrapper: Wrapper });
  await screen.findByText("Payee 001");
}

describe("register CSV export on a large history", () => {
  it("walks bounded batches and writes every matching row in order", async () => {
    await renderRegister();
    // The table itself only loaded its first batch.
    expect(screen.queryByText("Payee 011")).toBeNull();

    fireEvent.click(exportButton());
    await waitFor(() => expect(downloadedBlobs).toHaveLength(1));

    // Three bounded requests instead of one unbounded one.
    expect(
      exportRequests().map((url) => url.searchParams.get("offset")),
    ).toEqual(["0", "100", "200"]);
    // No request ever asks for the whole register.
    expect(
      txnRequests.every((url) => url.searchParams.has("limit")),
    ).toBe(true);

    const csv = await downloadedBlobs[0].text();
    const lines = csv.split("\n");
    expect(lines).toHaveLength(251);
    expect(lines[0]).toContain("Date,Type,Check #,Payee");
    expect(lines[1]).toContain("Payee 001");
    expect(lines[100]).toContain("Payee 100");
    expect(lines[101]).toContain("Payee 101");
    expect(lines[250]).toContain("Payee 250");
  });

  it("shows a working state while the export runs", async () => {
    await renderRegister();
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
    expect(exportButton().textContent).toContain("Export");
  });

  it("reports a failed batch instead of downloading a truncated file", async () => {
    await renderRegister();
    failAtOffset = 100;

    fireEvent.click(exportButton());
    await waitFor(() => expect(toastCalls).toHaveLength(1));

    expect(toastCalls[0].title).toBe("Export failed");
    // Nothing was written — a partial walk must never become a CSV.
    expect(downloadedBlobs).toHaveLength(0);
    await waitFor(() => expect(exportButton()).not.toBeDisabled());
  });
});
