/** @vitest-environment jsdom */

/**
 * Regression guard for the Register inline-add row alignment contract.
 *
 * The BlankRow / InlineBlankRows components render their input cells inside the
 * SAME `<table>` as the data rows, so their column alignment depends entirely on
 * the shared `<colgroup>`. The table uses `table-layout: fixed`, which means a
 * cell lines up under a header purely by its ordinal position. If a future
 * column-width or colgroup change adds/removes a column (or reorders cells),
 * the inline-add inputs would silently stop lining up with their headers.
 *
 * These tests mount the real RegisterPage with mocked finance data and assert
 * the structural invariants that keep the grid aligned:
 *   - colSpan=9 (standard account, Balance column present): the inline-add row
 *     renders one <td> per header column, with each input in the cell whose
 *     position matches its header label.
 *   - colSpan=8 (Undeposited Funds account, Balance column hidden): the grid
 *     collapses to 8 columns across <colgroup>, header, and data rows. The
 *     inline-add row is intentionally unavailable for UF accounts (entries are
 *     created via Receive Payments), so the "Add entry" affordance is disabled.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RegisterPage from "@/pages/finance/register";
import { makeAuthWrapper } from "./test-utils";
import type { SessionUser } from "@/lib/api";

const ORG_ID = "org-1";

const LAB_ADMIN: SessionUser = {
  id: "u-1",
  username: "labadmin",
  role: "admin",
  userType: "lab",
};

type AccountType = "checking" | "undeposited_funds";

function makeAccount(accountType: AccountType) {
  return {
    id: accountType === "undeposited_funds" ? "acct-uf" : "acct-chk",
    organizationId: ORG_ID,
    name: accountType === "undeposited_funds" ? "Undeposited Funds" : "Checking",
    accountType,
    institution: null,
    last4: null,
    openingBalance: "0",
    bookBalance: "0",
    clearedBalance: "0",
    unreconciledBalance: "0",
    isArchived: false,
  };
}

function makeTxn(bankAccountId: string) {
  return {
    id: "txn-1",
    bankAccountId,
    txnDate: "2026-06-01T00:00:00.000Z",
    type: "other",
    checkNumber: "1001",
    payee: "Acme Supply",
    memo: null,
    categoryId: null,
    debitAmount: "10",
    creditAmount: "0",
    runningBalance: "-10",
    cleared: false,
    reconciled: false,
    status: "posted",
    source: "manual",
    invoices: [],
    transferGroupId: null,
    vendorId: null,
  };
}

/**
 * Routes the global fetch (apiFetch builds `/api/<path>` URLs in jsdom) to
 * canned finance data. The single `accountType` switch is all that differs
 * between the two variants under test.
 */
function installFetchMock(accountType: AccountType) {
  const account = makeAccount(accountType);
  const txns = [makeTxn(account.id)];
  const transactionPosts: unknown[] = [];

  function json(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/organizations")) {
      return json([{ id: ORG_ID, name: "Test Lab", type: "lab" }]);
    }
    if (url.includes("/api/finance/accounts")) {
      return json([account]);
    }
    if (url.includes("/api/finance/categories")) {
      return json([]);
    }
    if (url.includes("/api/finance/vendors")) {
      return json([]);
    }
    if (url.includes("/api/finance/undeposited-funds")) {
      return json({ count: 0, total: 0 });
    }
    if (url.includes("/api/finance/transactions")) {
      if (init?.method === "POST") {
        transactionPosts.push(JSON.parse(String(init.body)));
        return json({ id: "txn-new" });
      }
      return json(txns);
    }
    return json({});
  }) as typeof fetch;
  return transactionPosts;
}

function renderRegister() {
  const Wrapper = makeAuthWrapper("/finance/register", {
    user: LAB_ADMIN,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  return render(
    <Wrapper>
      <RegisterPage />
    </Wrapper>
  );
}

function headerCells(container: HTMLElement) {
  const headerRow = container.querySelector("thead tr");
  if (!headerRow) throw new Error("register header row not rendered");
  return Array.from(headerRow.querySelectorAll(":scope > th"));
}

function colgroupCols(container: HTMLElement) {
  const colgroup = container.querySelector("colgroup");
  if (!colgroup) throw new Error("register colgroup not rendered");
  return Array.from(colgroup.querySelectorAll(":scope > col"));
}

describe("Register inline-add row alignment", () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom doesn't implement scrollIntoView; the BlankRow scrolls itself into
    // view on mount, which would otherwise throw inside the effect.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  it("11-col (Balance present): inline-add inputs line up under each header column", async () => {
    installFetchMock("checking");
    const { container } = renderRegister();

    // Wait for the register to finish loading (header + data row present).
    await screen.findByText("Acme Supply");

    // Standard accounts expose all 11 columns:
    // Date | Num | Payee | Account | Category | Payment | Deposit | ✓ | Balance | Memo | Actions
    expect(headerCells(container)).toHaveLength(11);
    expect(colgroupCols(container)).toHaveLength(11);
    expect(screen.getByRole("columnheader", { name: "Cleared" })).toBeTruthy();

    // Open the inline-add row.
    fireEvent.click(screen.getByRole("button", { name: /add entry/i }));

    // The Num input uniquely identifies the inline-add row.
    const numInput = await screen.findByPlaceholderText("Num");
    await waitFor(() => expect(numInput).toHaveFocus());
    const blankRow = numInput.closest("tr");
    expect(blankRow).not.toBeNull();

    const cells = Array.from(
      blankRow!.querySelectorAll(":scope > td")
    ) as HTMLTableCellElement[];

    // One cell per header column keeps the fixed-layout grid aligned.
    expect(cells).toHaveLength(11);

    // Each input sits in the cell whose ordinal position matches its header.
    // Date (0) holds no input here — when the date picker chip is shown the
    // date lives in a separate full-width row above the inputs.
    expect(cells[1].querySelector('input[placeholder="Num"]')).not.toBeNull();
    expect(cells[2].querySelector('input[placeholder="Payee"]')).not.toBeNull();
    // Account (3) is the register's own account: read-only text, no input.
    expect(cells[3].querySelector("input")).toBeNull();
    expect(cells[3].textContent).toContain("Checking");
    // Category (4) is the CategorySelect typeahead input.
    expect(cells[4].querySelector("input")).not.toBeNull();
    // Payment (5) and Deposit (6) are the two numeric amount inputs.
    expect(cells[5].querySelector('input[type="number"]')).not.toBeNull();
    expect(cells[6].querySelector('input[type="number"]')).not.toBeNull();
    // Memo (9) is a text input after Balance (8).
    expect(cells[9].querySelector('input[placeholder="Memo"]')).not.toBeNull();
    // Actions (10) holds the Save control.
    expect(
      cells[10].querySelector('button[aria-label="Save row"]')
    ).not.toBeNull();

    // The full-width date-picker row must span exactly the column count, or it
    // would push the inputs out of alignment.
    const dateRow = container.querySelector('td[colspan="11"]');
    expect(dateRow).not.toBeNull();
    expect(dateRow!.getAttribute("colspan")).toBe(String(headerCells(container).length));
  });

  it("opens one row, refocuses it on repeated clicks, and dismisses then reopens cleanly", async () => {
    installFetchMock("checking");
    renderRegister();
    await screen.findByText("Acme Supply");

    const addEntry = screen.getByRole("button", { name: /add entry/i });
    fireEvent.click(addEntry);
    const numInput = await screen.findByPlaceholderText("Num");
    await waitFor(() => expect(numInput).toHaveFocus());
    expect(screen.getAllByPlaceholderText("Num")).toHaveLength(1);

    fireEvent.blur(numInput);
    fireEvent.click(addEntry);
    await waitFor(() => expect(numInput).toHaveFocus());
    expect(screen.getAllByPlaceholderText("Num")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /dismiss row/i }));
    await waitFor(() => expect(screen.queryByPlaceholderText("Num")).toBeNull());

    fireEvent.click(addEntry);
    const reopenedInput = await screen.findByPlaceholderText("Num");
    await waitFor(() => expect(reopenedInput).toHaveFocus());
    expect(screen.getAllByPlaceholderText("Num")).toHaveLength(1);
  });

  it("saves a valid row, dismisses the fresh row, and reopens one focused row", async () => {
    const transactionPosts = installFetchMock("checking");
    renderRegister();
    await screen.findByText("Acme Supply");

    fireEvent.click(screen.getByRole("button", { name: /add entry/i }));
    fireEvent.change(await screen.findByPlaceholderText("Payee"), {
      target: { value: "New Vendor" },
    });
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], {
      target: { value: "25.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save row/i }));

    await waitFor(() => expect(transactionPosts).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByPlaceholderText("Num")).toHaveLength(1));
    await waitFor(() => expect(screen.getByPlaceholderText("Num")).toHaveFocus());
    expect(transactionPosts[0]).toMatchObject({
      payee: "New Vendor",
      payment: 25.5,
      bankAccountId: "acct-chk",
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss row/i }));
    await waitFor(() => expect(screen.queryByPlaceholderText("Num")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /add entry/i }));
    const reopenedInput = await screen.findByPlaceholderText("Num");
    await waitFor(() => expect(reopenedInput).toHaveFocus());
    expect(screen.getAllByPlaceholderText("Num")).toHaveLength(1);
  });

  it("10-col (Undeposited Funds): Balance column drops out and inline-add is disabled", async () => {
    installFetchMock("undeposited_funds");
    const { container } = renderRegister();

    await screen.findByText("Acme Supply");

    // UF accounts hide the Balance column everywhere: colgroup, header, and
    // every data row collapse from 11 to 10 columns in lockstep.
    expect(headerCells(container)).toHaveLength(10);
    expect(colgroupCols(container)).toHaveLength(10);

    const dataRow = screen.getByText("Acme Supply").closest("tr");
    expect(dataRow).not.toBeNull();
    expect(dataRow!.querySelectorAll(":scope > td")).toHaveLength(10);

    // Inline-add is intentionally unavailable for UF accounts, so no BlankRow
    // is ever mounted into the 10-column grid.
    const addEntry = screen.getByRole("button", { name: /add entry/i });
    expect(addEntry).toBeDisabled();
    expect(addEntry).toHaveAttribute(
      "title",
      expect.stringMatching(/receive payments/i)
    );

    fireEvent.click(addEntry);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Num")).toBeNull();
    });
  });
});
