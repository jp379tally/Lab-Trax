/** @vitest-environment jsdom */

/**
 * Regression guard for the Register expandable in-row editors.
 *
 * Clicking a transaction row expands an editor that renders inside the SAME
 * fixed-layout `<table>` as the data rows. Both editors span the full grid with
 * a single `<td colSpan={cols}>` cell, where `cols = isUF ? 8 : 9` mirrors the
 * Balance column being hidden for Undeposited Funds accounts:
 *   - InlineEditRow  — the standard edit drawer for a normal transaction
 *   - TransferEditRow — the drawer for a transaction with a transferGroupId
 *
 * Because the table uses `table-layout: fixed`, the spanning cell must cover
 * EXACTLY the header column count. If a future column/colgroup change desyncs
 * that `cols` value from the real column count, the drawer would render too
 * narrow or too wide and visually break the register. These tests assert the
 * invariant dynamically (drawer colSpan === live header `<th>` count) so the
 * check keeps holding even if the literal column numbers change later.
 *
 * Column variants:
 *   - 9 columns (standard account, Balance present): both the InlineEditRow and
 *     TransferEditRow drawers are reachable by clicking a row, so we assert
 *     their colSpan equals the 9-column header count.
 *   - 8 columns (Undeposited Funds, Balance hidden): UF rows are intentionally
 *     NOT clickable (entries come from Receive Payments), so no edit drawer can
 *     ever mount into the 8-column grid. We assert the grid collapses to 8 and
 *     that the 8-column spanning cell that DOES render (the empty/loading state,
 *     which shares the identical `isUF ? 8 : 9` source) stays aligned — proving
 *     the spanning value tracks the header count in the 8-column variant too.
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
type TxnKind = "normal" | "transfer";

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

function makeTxn(bankAccountId: string, kind: TxnKind) {
  const isTransfer = kind === "transfer";
  return {
    id: "txn-1",
    bankAccountId,
    txnDate: "2026-06-01T00:00:00.000Z",
    type: isTransfer ? "transfer" : "other",
    checkNumber: isTransfer ? null : "1001",
    payee: isTransfer ? "Transfer to Savings" : "Acme Supply",
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
    transferGroupId: isTransfer ? "grp-1" : null,
    vendorId: null,
  };
}

/**
 * Routes the global fetch (apiFetch builds `/api/<path>` URLs in jsdom) to
 * canned finance data. `txns` lets a test render an empty register.
 */
function installFetchMock(accountType: AccountType, kind: TxnKind, empty = false) {
  const account = makeAccount(accountType);
  const txns = empty ? [] : [makeTxn(account.id, kind)];

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

/**
 * Walks up from a label unique to the open drawer to its `<tr>`, then returns
 * the single spanning `<td colSpan>` cell that the drawer renders.
 */
function drawerSpanCell(label: HTMLElement): HTMLTableCellElement {
  const row = label.closest("tr");
  if (!row) throw new Error("edit drawer row not found");
  const span = row.querySelector(":scope > td[colspan]") as HTMLTableCellElement | null;
  if (!span) throw new Error("drawer spanning cell not found");
  return span;
}

describe("Register edit/transfer drawer alignment", () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom doesn't implement scrollIntoView; effects call it on mount.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  it("InlineEditRow (9-col): spanning cell colSpan === header column count", async () => {
    installFetchMock("checking", "normal");
    const { container } = renderRegister();

    // Click the transaction row to expand its inline edit drawer.
    const payeeText = await screen.findByText("Acme Supply");
    expect(headerCells(container)).toHaveLength(9);

    fireEvent.click(payeeText);

    // The "Memo" label is unique to the InlineEditRow drawer (the data row has
    // no such label), so it pins us to the expanded editor.
    const memoLabel = await screen.findByText("Memo");
    const span = drawerSpanCell(memoLabel);

    expect(Number(span.getAttribute("colspan"))).toBe(headerCells(container).length);
    expect(span.getAttribute("colspan")).toBe("9");
  });

  it("TransferEditRow (9-col): spanning cell colSpan === header column count", async () => {
    installFetchMock("checking", "transfer");
    const { container } = renderRegister();

    const payeeText = await screen.findByText("Transfer to Savings");
    expect(headerCells(container)).toHaveLength(9);

    fireEvent.click(payeeText);

    // "From account" is unique to the TransferEditRow drawer.
    const fromLabel = await screen.findByText("From account");
    const span = drawerSpanCell(fromLabel);

    expect(Number(span.getAttribute("colspan"))).toBe(headerCells(container).length);
    expect(span.getAttribute("colspan")).toBe("9");
  });

  it("Undeposited Funds (8-col): rows are not expandable into a drawer", async () => {
    installFetchMock("undeposited_funds", "normal");
    const { container } = renderRegister();

    const payeeText = await screen.findByText("Acme Supply");
    expect(headerCells(container)).toHaveLength(8);

    // UF rows are intentionally not clickable, so no edit drawer mounts into the
    // 8-column grid. Clicking must NOT open the InlineEditRow ("Memo" label).
    fireEvent.click(payeeText);
    await waitFor(() => {
      expect(screen.queryByText("Memo")).toBeNull();
    });
  });

  it("Undeposited Funds (8-col): 8-column spanning cell stays aligned with the header", async () => {
    // The empty-state spanning cell shares the identical `isUF ? 8 : 9` source as
    // the drawer's `cols`, so it proves the 8-column spanning value tracks the
    // collapsed header count even though the drawer itself is unreachable on UF.
    installFetchMock("undeposited_funds", "normal", /* empty */ true);
    const { container } = renderRegister();

    const emptyCell = (await screen.findByText(
      /no transactions match/i
    )).closest("td") as HTMLTableCellElement;
    expect(emptyCell).not.toBeNull();

    expect(headerCells(container)).toHaveLength(8);
    expect(Number(emptyCell.getAttribute("colspan"))).toBe(headerCells(container).length);
    expect(emptyCell.getAttribute("colspan")).toBe("8");
  });
});
