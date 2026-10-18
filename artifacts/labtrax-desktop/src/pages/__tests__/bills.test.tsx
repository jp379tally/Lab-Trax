/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import BillsPage from "@/pages/finance/bills";
import { apiFetch } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const bill = {
  id: "bill-1",
  labOrganizationId: "lab",
  vendorId: "vendor-1",
  vendorName: "Acme Supply",
  vendorIsActive: true,
  billNumber: "AC-100",
  billDate: "2026-03-01T00:00:00.000Z",
  dueDate: "2026-03-31T00:00:00.000Z",
  termsDays: 30,
  memo: null,
  total: "125.50",
  amountPaid: "25.00",
  amountCredited: "0.00",
  balanceDue: "100.50",
  status: "partially_paid",
  voidedAt: null,
  voidReason: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  lines: [],
};

const acme = { id: "vendor-1", name: "Acme Supply", isActive: true, vendorType: "supplier", paymentTermsDays: 30 };
const duplicatePayee = "A payee with this name already exists in this lab.";

let posts: any[];
let duplicate: boolean;
let vendors: any[];
let vendorPosts: any[];
let refuseVendor: boolean;
let vendorListFetches: number;
/** While set, vendor lists wait for it before answering. */
let holdVendorList: Promise<void> | null;
/** While set, a vendor save waits for it before answering. */
let holdVendorPost: Promise<void> | null;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status >= 400 ? data : { ok: true, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  localStorage.clear();
  posts = [];
  duplicate = true;
  vendors = [acme];
  vendorPosts = [];
  refuseVendor = false;
  vendorListFetches = 0;
  holdVendorList = null;
  holdVendorPost = null;
  vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString(), "http://localhost").pathname;
    if (path.endsWith("/organizations")) return json([{ id: "lab", name: "Lab", type: "lab" }]);
    if (path.endsWith("/finance/accounts")) return json([]);
    if (path.endsWith("/finance/undeposited-funds")) return json({ count: 0, total: 0 });
    if (path.endsWith("/finance/vendors") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      vendorPosts.push(body);
      if (holdVendorPost) await holdVendorPost;
      if (refuseVendor) return json({ ok: false, message: duplicatePayee }, 409);
      const created = {
        id: `vendor-${vendors.length + 1}`,
        name: body.name,
        isActive: true,
        vendorType: body.vendorType,
        paymentTermsDays: body.paymentTermsDays,
        phone: body.phone,
        email: body.email,
      };
      vendors = [...vendors, created];
      return json(created, 201);
    }
    if (path.endsWith("/finance/vendors")) {
      vendorListFetches += 1;
      if (holdVendorList) await holdVendorList;
      return json(vendors);
    }
    if (path.endsWith("/finance/bills/bill-1")) {
      return json({
        ...bill,
        lines: [{ id: "line-1", categoryId: null, description: "Porcelain", amount: "125.50" }],
        payments: [],
        events: [],
      });
    }
    if (path.endsWith("/finance/categories")) {
      return json([{ id: "cat-1", name: "Materials", kind: "expense" }]);
    }
    if (path.endsWith("/finance/bills") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (duplicate && !body.acknowledgeDuplicateReference) {
        return json({
          ok: false,
          error: {
            code: "duplicate_bill_reference",
            message: "Acme Supply already has a bill numbered AC-100. Confirm to save it anyway.",
          },
        }, 409);
      }
      return json(bill, 201);
    }
    if (path.endsWith("/finance/bills")) return json([bill]);
    return json({});
  }));
});

afterEach(() => vi.unstubAllGlobals());

async function page(extra?: ReactNode) {
  const Wrapper = makeAuthWrapper("/finance/bills", {
    user: { id: "u", role: "admin", userType: "lab", practiceOrganizationId: "lab" } as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(<Wrapper><BillsPage />{extra}</Wrapper>);
  await screen.findByText("AC-100");
}

/** Stands in for the Payees tab, which keeps its own list of the lab's vendors. */
function PayeesList() {
  const list = useQuery({
    queryKey: ["finance", "vendors", "lab", "all"],
    queryFn: () => apiFetch<Array<{ id: string; name: string }>>("/finance/vendors?organizationId=lab"),
  });
  return (
    <ul aria-label="Payees list">
      {(list.data ?? []).map((vendor) => <li key={vendor.id}>{vendor.name}</li>)}
    </ul>
  );
}

const vendorField = () => screen.getByLabelText("Vendor") as HTMLSelectElement;
const newVendorWindow = () => screen.queryByRole("dialog", { name: "New vendor" });

async function openNewBill() {
  fireEvent.click(screen.getByRole("button", { name: "Enter Bill" }));
  await screen.findByRole("heading", { name: "Enter bill" });
  await screen.findByRole("option", { name: "Acme Supply" });
}

/** Picks "+ Add new vendor…" the way a click in the open list does. */
async function chooseAddNew() {
  const option = within(vendorField()).getByRole("option", { name: "+ Add new vendor…" }) as HTMLOptionElement;
  fireEvent.change(vendorField(), { target: { value: option.value } });
  return screen.findByRole("dialog", { name: "New vendor" });
}

function fillLine(description: string, amount: string) {
  const editor = screen.getByRole("heading", { name: "Enter bill" }).parentElement!.parentElement!;
  const lineInputs = editor.querySelectorAll("tbody input");
  fireEvent.change(lineInputs[0]!, { target: { value: description } });
  fireEvent.change(lineInputs[1]!, { target: { value: amount } });
}

describe("Bills", () => {
  it("renders balances and acknowledges a duplicate reference before re-submitting", async () => {
    await page();
    expect(screen.getByText("Acme Supply")).toBeInTheDocument();
    expect(screen.getAllByText("$100.50").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Enter Bill" }));
    await screen.findByRole("heading", { name: "Enter bill" });
    await screen.findByRole("option", { name: "Acme Supply" });
    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: "vendor-1" } });
    fireEvent.change(screen.getByLabelText("Bill number"), { target: { value: " AC-100 " } });
    fireEvent.change(screen.getByLabelText("Bill date"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText(/^Due date/), { target: { value: "2026-03-31" } });
    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: " Monthly supplies " } });
    const dialog = screen.getByRole("heading", { name: "Enter bill" }).parentElement!.parentElement!;
    const lineInputs = dialog.querySelectorAll("tbody input");
    fireEvent.change(lineInputs[0]!, { target: { value: "Porcelain" } });
    fireEvent.change(lineInputs[1]!, { target: { value: "125.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save bill" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    await screen.findByText(/already has a bill numbered AC-100/);
    expect(posts[0]).toMatchObject({
      organizationId: "lab",
      vendorId: "vendor-1",
      billNumber: "AC-100",
      billDate: "2026-03-01",
      dueDate: "2026-03-31",
      termsDays: 30,
      memo: "Monthly supplies",
      lines: [{ categoryId: null, description: "Porcelain", amount: 125.5 }],
    });
    expect(posts[0]).not.toHaveProperty("acknowledgeDuplicateReference");

    duplicate = false;
    fireEvent.click(screen.getByRole("button", { name: "Save it anyway" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ acknowledgeDuplicateReference: true });
  });

  it("lists Add new vendor first in a new bill's vendor list", async () => {
    await page();
    await openNewBill();

    const rows = within(vendorField()).getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual(["+ Add new vendor…", "Acme Supply"]);
    // The empty field still reads "Select…", from a row the open list hides.
    expect(vendorField()).toHaveValue("");
    expect(vendorField()).toHaveDisplayValue("Select…");
  });

  it("keeps the bill's vendor when the New vendor window is closed or cancelled", async () => {
    duplicate = false;
    await page();
    await openNewBill();

    let dialog = await chooseAddNew();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Never saved" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(newVendorWindow()).not.toBeInTheDocument();
    expect(vendorField()).toHaveValue("");
    expect(vendorField()).toHaveFocus();

    fireEvent.change(vendorField(), { target: { value: "vendor-1" } });
    dialog = await chooseAddNew();
    expect(vendorField()).toHaveValue("vendor-1");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(newVendorWindow()).not.toBeInTheDocument();
    expect(vendorField()).toHaveValue("vendor-1");
    expect(vendorPosts).toEqual([]);

    fillLine("Porcelain", "125.50");
    fireEvent.click(screen.getByRole("button", { name: "Save bill" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].vendorId).toBe("vendor-1");
    expect(vendorPosts).toEqual([]);
  });

  it("creates a vendor from the bill, selects it at once and saves the bill with it", async () => {
    duplicate = false;
    await page(<PayeesList />);
    const payees = screen.getByRole("list", { name: "Payees list" });
    await within(payees).findByText("Acme Supply");
    await openNewBill();
    fireEvent.change(screen.getByLabelText("Bill number"), { target: { value: "BD-7" } });
    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "Crowns" } });

    const dialog = await chooseAddNew();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "  Bright Dental Supply  " } });
    fireEvent.change(within(dialog).getByLabelText("Default terms (days)"), { target: { value: "45" } });
    fireEvent.change(within(dialog).getByLabelText("Phone"), { target: { value: " 555-0100 " } });
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "orders@bright.example" } });

    // Hold the refreshed vendor lists, so the selection can only come from the
    // save response.
    let releaseVendorList!: () => void;
    holdVendorList = new Promise((resolve) => {
      releaseVendorList = resolve;
    });
    let releaseVendorPost!: () => void;
    holdVendorPost = new Promise((resolve) => {
      releaseVendorPost = resolve;
    });
    const listFetchesBeforeSave = vendorListFetches;
    const saveVendor = within(dialog).getByRole("button", { name: "Save vendor" });
    fireEvent.click(saveVendor);
    // A second submit in the same moment, before Save can disable, is ignored.
    fireEvent.submit(saveVendor.closest("form")!);
    await waitFor(() => expect(saveVendor).toBeDisabled());
    fireEvent.click(saveVendor);
    expect(vendorPosts).toHaveLength(1);
    // The window cannot be dismissed mid-save, so a vendor is never created
    // behind a Cancel.
    for (const name of ["Cancel", "Close"]) {
      const dismiss = within(dialog).getByRole("button", { name });
      expect(dismiss).toBeDisabled();
      fireEvent.click(dismiss);
    }
    expect(newVendorWindow()).toBe(dialog);
    releaseVendorPost();

    await waitFor(() => expect(newVendorWindow()).not.toBeInTheDocument());
    expect(vendorPosts).toEqual([
      {
        organizationId: "lab",
        name: "Bright Dental Supply",
        vendorType: "vendor",
        paymentTermsDays: 45,
        phone: "555-0100",
        email: "orders@bright.example",
      },
    ]);
    expect(vendorField()).toHaveValue("vendor-2");
    expect(vendorField()).toHaveDisplayValue("Bright Dental Supply");
    expect(screen.getByLabelText("Terms (days)")).toHaveValue(45);
    expect(screen.getByLabelText("Bill number")).toHaveValue("BD-7");
    expect(screen.getByLabelText("Memo")).toHaveValue("Crowns");
    await waitFor(() => expect(vendorListFetches).toBeGreaterThan(listFetchesBeforeSave));
    expect(within(payees).queryByText("Bright Dental Supply")).not.toBeInTheDocument();

    holdVendorList = null;
    releaseVendorList();
    await within(payees).findByText("Bright Dental Supply");
    expect(within(vendorField()).getAllByRole("option", { name: "Bright Dental Supply" })).toHaveLength(1);
    expect(vendorField()).toHaveValue("vendor-2");

    fillLine("Crown", "300");
    fireEvent.click(screen.getByRole("button", { name: "Save bill" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ vendorId: "vendor-2", termsDays: 45, billNumber: "BD-7", memo: "Crowns" });
    expect(vendorPosts).toHaveLength(1);
  });

  it("keeps the New vendor window open with the server's reason when the save is refused", async () => {
    refuseVendor = true;
    await page();
    await openNewBill();
    fireEvent.change(vendorField(), { target: { value: "vendor-1" } });

    const dialog = await chooseAddNew();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "acme supply" } });
    fireEvent.change(within(dialog).getByLabelText("Default terms (days)"), { target: { value: "15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save vendor" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(duplicatePayee);
    expect(newVendorWindow()).toBe(dialog);
    expect(within(dialog).getByLabelText("Name")).toHaveValue("acme supply");
    expect(within(dialog).getByLabelText("Default terms (days)")).toHaveValue("15");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save vendor" })).toBeEnabled());
    expect(vendorPosts).toHaveLength(1);
    expect(vendorField()).toHaveValue("vendor-1");
    expect(screen.getByLabelText("Terms (days)")).toHaveValue(30);

    // After a refusal the user can still back out.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(newVendorWindow()).not.toBeInTheDocument();
    expect(vendorField()).toHaveValue("vendor-1");
    expect(vendorPosts).toHaveLength(1);
  });

  it("steps past Add new vendor when arrow keys move through the closed field", async () => {
    await page();
    await openNewBill();

    // On Windows an arrow key changes a closed list's value directly.
    const addNew = within(vendorField()).getByRole("option", { name: "+ Add new vendor…" }) as HTMLOptionElement;
    fireEvent.keyDown(vendorField(), { key: "ArrowDown" });
    fireEvent.change(vendorField(), { target: { value: addNew.value } });
    expect(newVendorWindow()).not.toBeInTheDocument();
    expect(vendorField()).toHaveValue("vendor-1");
    expect(screen.getByLabelText("Terms (days)")).toHaveValue(30);

    fireEvent.keyDown(vendorField(), { key: "ArrowUp" });
    fireEvent.change(vendorField(), { target: { value: addNew.value } });
    expect(newVendorWindow()).not.toBeInTheDocument();
    expect(vendorField()).toHaveValue("vendor-1");

    // Once the keystroke has passed, choosing the row opens the window again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await chooseAddNew();
    expect(vendorField()).toHaveValue("vendor-1");
  });

  it("keeps the vendor locked, with no Add new vendor row, when editing a bill", async () => {
    await page();
    fireEvent.click(screen.getByText("AC-100"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { name: "Edit bill" });

    await waitFor(() => expect(vendorField()).toHaveValue("vendor-1"));
    expect(vendorField()).toBeDisabled();
    expect(within(vendorField()).queryByRole("option", { name: "+ Add new vendor…" })).not.toBeInTheDocument();
  });
});