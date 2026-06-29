/** @vitest-environment jsdom */
/**
 * Regression suite: "Register selection stays findable after scrolling"
 *
 * The bank register's row selection has discoverability behaviour that has no
 * other test coverage:
 *   - opening a row auto-scrolls its edit panel into view, and
 *   - a sticky "1 entry selected — jump to it" pill appears whenever the
 *     selected row scrolls out of the register's viewport (tracked via an
 *     IntersectionObserver), and disappears again when it returns to view.
 *
 * These tests pin that behaviour so a future refactor of `expandedId`, the
 * scroll container, or the IntersectionObserver effect can't silently regress
 * it. The IntersectionObserver is mocked so the test can drive intersection
 * state directly.
 *
 * They also guard the subtle interaction bug that the pill must NOT trip the
 * document-level outside-click handler that resets `expandedId` to null —
 * clicking the pill keeps the selection, it doesn't clear it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { BankAccount, BankTransaction } from "@/lib/types";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import { RegisterTable } from "@/pages/finance/register";

const ORG_ID = "lab_xyz";
const ACCOUNT_ID = "acct-1";

const ACCOUNT: BankAccount = {
  id: ACCOUNT_ID,
  labOrganizationId: ORG_ID,
  name: "Operating",
  openingBalance: "0",
  currency: "USD",
  isArchived: false,
  accountType: "checking",
  bookBalance: "100",
  clearedBalance: "50",
  unreconciledBalance: "0",
};

function makeTxn(id: string, payee: string): BankTransaction {
  return {
    id,
    labOrganizationId: ORG_ID,
    bankAccountId: ACCOUNT_ID,
    txnDate: "2026-06-01T00:00:00.000Z",
    type: "check",
    checkNumber: null,
    payee,
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
    transferGroupId: null,
  };
}

const TXNS = [makeTxn("txn-1", "Acme Supply"), makeTxn("txn-2", "Beta Dental")];

/**
 * Captured IntersectionObserver instances. The component creates one observer
 * per open selection; the test grabs the most recent one and drives its
 * callback to simulate the selected row scrolling in/out of view.
 */
type CapturedObserver = {
  cb: IntersectionObserverCallback;
  instance: IntersectionObserver;
};
let observers: CapturedObserver[] = [];

class MockIntersectionObserver {
  root: Element | Document | null = null;
  rootMargin = "";
  thresholds: ReadonlyArray<number> = [];
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    observers.push({ cb, instance: this as unknown as IntersectionObserver });
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function fireIntersection(isIntersecting: boolean, opts?: { above?: boolean }) {
  const latest = observers[observers.length - 1];
  if (!latest) throw new Error("no IntersectionObserver was created");
  const rootBounds = { top: 100, bottom: 500 } as DOMRectReadOnly;
  const boundingClientRect = {
    top: opts?.above ? 0 : 600,
  } as DOMRectReadOnly;
  const entry = {
    isIntersecting,
    rootBounds,
    boundingClientRect,
  } as unknown as IntersectionObserverEntry;
  latest.cb([entry], latest.instance);
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    MockIntersectionObserver as unknown as typeof IntersectionObserver,
  );
  // jsdom has no scrollIntoView; the open-selection effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/finance/transactions")) return Promise.resolve(TXNS);
    if (url.startsWith("/finance/categories")) return Promise.resolve([]);
    if (url.startsWith("/finance/vendors")) return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderRegister() {
  return render(
    <RegisterTable
      organizationId={ORG_ID}
      accountId={ACCOUNT_ID}
      accounts={[ACCOUNT]}
    />,
    { wrapper: makeAuthWrapper() },
  );
}

async function selectFirstRow() {
  const cell = await screen.findByText("Acme Supply");
  const row = cell.closest("tr")!;
  fireEvent.click(row);
  return row;
}

describe("Register selection — jump-to-it pill", () => {
  it("shows the pill when the selected row scrolls out of view and hides it when in view", async () => {
    renderRegister();
    await selectFirstRow();

    // The open-selection effect creates an observer; nothing reported yet so
    // the pill is hidden.
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    expect(screen.queryByText(/jump to it/i)).not.toBeInTheDocument();

    // Selection scrolls out of view -> pill appears.
    fireIntersection(false);
    expect(
      await screen.findByText(/1 entry selected — jump to it/i),
    ).toBeInTheDocument();

    // Selection scrolls back into view -> pill disappears.
    fireIntersection(true);
    await waitFor(() =>
      expect(screen.queryByText(/jump to it/i)).not.toBeInTheDocument(),
    );
  });

  it("does not show the pill when no row is selected", async () => {
    renderRegister();
    await screen.findByText("Acme Supply");
    expect(screen.queryByText(/jump to it/i)).not.toBeInTheDocument();
    // No selection -> no observer to report on.
    expect(observers.length).toBe(0);
  });

  it("clicking the pill keeps the selection (does not trip the outside-click handler)", async () => {
    renderRegister();
    await selectFirstRow();

    fireIntersection(false);
    const pill = await screen.findByText(/1 entry selected — jump to it/i);
    const pillButton = pill.closest("button")!;

    // The pill stops mousedown propagation so the document outside-click
    // handler never fires and the selection stays open. Simulate the real
    // event order: mousedown (which the document listener watches) then click.
    fireEvent.mouseDown(pillButton);
    fireEvent.click(pillButton);

    // Selection still active: the observer was NOT torn down and the pill is
    // still on screen (it would vanish if expandedId had been cleared).
    expect(
      screen.getByText(/1 entry selected — jump to it/i),
    ).toBeInTheDocument();
    expect((Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("a document mousedown outside the register clears the selection and hides the pill", async () => {
    renderRegister();
    await selectFirstRow();
    fireIntersection(false);
    expect(
      await screen.findByText(/1 entry selected — jump to it/i),
    ).toBeInTheDocument();

    // A real outside click (mousedown bubbling to document) clears expandedId.
    fireEvent.mouseDown(document.body);
    await waitFor(() =>
      expect(screen.queryByText(/jump to it/i)).not.toBeInTheDocument(),
    );
  });

  it("toggles selection off when the same row is clicked again (expandedId deselect)", async () => {
    renderRegister();
    const row = await selectFirstRow();
    fireIntersection(false);
    expect(
      await screen.findByText(/1 entry selected — jump to it/i),
    ).toBeInTheDocument();

    // Clicking the already-selected row toggles it closed -> pill clears
    // because expandedId is back to null.
    fireEvent.click(row);
    await waitFor(() =>
      expect(screen.queryByText(/jump to it/i)).not.toBeInTheDocument(),
    );
  });
});
