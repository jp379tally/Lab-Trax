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

import { describe, it, expect, beforeEach } from "vitest";
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

  function json(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  globalThis.fetch = (async (input: RequestInfo | URL) => {
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
      return json(txns);
    }
    return json({});
  }) as typeof fetch;
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
  });

  it("colSpan=9 (Balance present): inline-add inputs line up under each header column", async () => {
    installFetchMock("checking");
    const { container } = renderRegister();

    // Wait for the register to finish loading (header + data row present).
    await screen.findByText("Acme Supply");

    // Standard accounts expose all 9 columns:
    // Date | Num | Payee | Account | Payment | ✓ | Deposit | Balance | Actions
    expect(headerCells(container)).toHaveLength(9);
    expect(colgroupCols(container)).toHaveLength(9);

    // Open the inline-add row.
    fireEvent.click(screen.getByRole("button", { name: /add entry/i }));

    // The Num input uniquely identifies the inline-add row.
    const numInput = await screen.findByPlaceholderText("Num");
    const blankRow = numInput.closest("tr");
    expect(blankRow).not.toBeNull();

    const cells = Array.from(
      blankRow!.querySelectorAll(":scope > td")
    ) as HTMLTableCellElement[];

    // One cell per header column keeps the fixed-layout grid aligned.
    expect(cells).toHaveLength(9);

    // Each input sits in the cell whose ordinal position matches its header.
    // Date (0) holds no input here — when the date picker chip is shown the
    // date lives in a separate full-width row above the inputs.
    expect(cells[1].querySelector('input[placeholder="Num"]')).not.toBeNull();
    expect(cells[2].querySelector('input[placeholder="Payee"]')).not.toBeNull();
    // Account/Category (3) is the CategorySelect typeahead input.
    expect(cells[3].querySelector("input")).not.toBeNull();
    // Payment (4) and Deposit (6) are the two numeric amount inputs.
    expect(cells[4].querySelector('input[type="number"]')).not.toBeNull();
    expect(cells[6].querySelector('input[type="number"]')).not.toBeNull();
    // Actions (8) holds the Save control.
    expect(
      cells[8].querySelector('button[aria-label="Save row"]')
    ).not.toBeNull();

    // The full-width date-picker row must span exactly the column count, or it
    // would push the inputs out of alignment.
    const dateRow = container.querySelector('td[colspan="9"]');
    expect(dateRow).not.toBeNull();
    expect(dateRow!.getAttribute("colspan")).toBe(String(headerCells(container).length));
  });

  it("colSpan=8 (Undeposited Funds): Balance column drops out and inline-add is disabled", async () => {
    installFetchMock("undeposited_funds");
    const { container } = renderRegister();

    await screen.findByText("Acme Supply");

    // UF accounts hide the Balance column everywhere: colgroup, header, and
    // every data row collapse from 9 to 8 columns in lockstep.
    expect(headerCells(container)).toHaveLength(8);
    expect(colgroupCols(container)).toHaveLength(8);

    const dataRow = screen.getByText("Acme Supply").closest("tr");
    expect(dataRow).not.toBeNull();
    expect(dataRow!.querySelectorAll(":scope > td")).toHaveLength(8);

    // Inline-add is intentionally unavailable for UF accounts, so no BlankRow
    // is ever mounted into the 8-column grid.
    const addEntry = screen.getByRole("button", { name: /add entry/i });
    expect(addEntry).toBeDisabled();

    fireEvent.click(addEntry);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Num")).toBeNull();
    });
  });
});
