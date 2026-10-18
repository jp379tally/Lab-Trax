import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import { Platform } from "react-native";
import InvoicesScreen, { resetInvoiceRegisterSnapshotsForTests } from "@/app/finance/invoices";
import { pagerItems, csvCell } from "@/lib/invoice-web-export";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";

const original = Platform.OS;
function seed(count: number, role = "admin") {
  setMockAppState({
    invoices: Array.from({ length: count }, (_, n) => ({
      id: `inv-${n}`, invoiceNumber: `INV-${n}`, status: "open", total: 10, balanceDue: 10,
      labOrganizationId: "lab-1", providerOrganization: { name: "Zenith" },
    })),
    meMemberships: [{ organizationId: "lab-1", role, status: "active", organization: { type: "lab" } }],
  });
}
afterEach(() => {
  cleanup(); resetMockAppState(); resetInvoiceRegisterSnapshotsForTests();
  Object.defineProperty(Platform, "OS", { value: original, configurable: true });
  vi.clearAllMocks();
});

describe("web numbered paging", () => {
  it("shows one page at a time and moves with the numbered pager", async () => {
    Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
    seed(60);
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-inv-0")).not.toBeNull();
    expect(screen.queryByTestId("invoice-inv-30")).toBeNull();
    expect(screen.getByTestId("invoice-range").props.children.join("")).toContain("1-25 of 60");
    await fireEvent.press(screen.getByTestId("invoice-page-2"));
    expect(screen.queryByTestId("invoice-inv-0")).toBeNull();
    expect(screen.queryByTestId("invoice-inv-30")).not.toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-page-size-50"));
    expect(screen.queryByTestId("invoice-inv-49")).not.toBeNull();
  });

  it("shows header actions for lab editors only", async () => {
    Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
    seed(3);
    const screen = await render(<InvoicesScreen />);
    await fireEvent.press(screen.getByTestId("invoice-statements"));
    expect(router.push).toHaveBeenCalledWith("/finance/statements");
    const assign = vi.fn();
    vi.stubGlobal("window", { ...globalThis.window, location: { assign } });
    await fireEvent.press(screen.getByTestId("invoice-new"));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0][0])).toMatch(/\/desktop\/invoices\?newInvoice=1$/);
    vi.unstubAllGlobals();
    expect(screen.queryByTestId("invoice-export")).not.toBeNull();
  });

  it("hides write header actions for read-only roles", async () => {
    Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
    seed(3, "technician");
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-new")).toBeNull();
    expect(screen.queryByTestId("invoice-statements")).toBeNull();
  });

  it("native renders no web pager or header actions", async () => {
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    seed(30);
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-pager")).toBeNull();
    expect(screen.queryByTestId("invoice-header-actions")).toBeNull();
  });
});

describe("pager and csv helpers", () => {
  it("condenses pages and neutralises formulas", () => {
    expect(pagerItems(30, 57)).toEqual([1, "gap", 29, 30, 31, "gap", 57]);
    expect(csvCell("@cmd")).toBe(`"'@cmd"`);
  });
});

import { fetchAllInvoiceRows, parseInvoicePage } from "@/lib/invoice-web-export";

describe("expo export strictness", () => {
  const sig = () => new AbortController().signal;
  it("rejects truncated, malformed and cancelled exports", async () => {
    await expect(fetchAllInvoiceRows({ signal: sig(), fetchPage: async () => ({ rows: [{ id: "a" } as never], total: 2, hasMore: false }) })).rejects.toThrow(/incomplete/);
    expect(() => parseInvoicePage({ rows: [], total: "0" })).toThrow(/unexpected/);
    expect(parseInvoicePage([])).toEqual([]);
    const c = new AbortController();
    await expect(fetchAllInvoiceRows({ signal: c.signal, fetchPage: async () => { c.abort(); return { rows: [], total: 0, hasMore: false }; } })).rejects.toThrow(/cancelled/);
    expect(csvCell("  =1")).toBe(`"'  =1"`);
  });
});
