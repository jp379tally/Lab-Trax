import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import * as RN from "react-native";
import { Platform } from "react-native";
import InvoicesScreen, { resetInvoiceRegisterSnapshotsForTests } from "@/app/finance/invoices";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";

const original = Platform.OS;
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] | null } | string;
function findDom(tree: unknown, id: string): { props: Record<string, any> } | null {
  const walk = (n: Node | Node[] | null | undefined): { props: Record<string, any> } | null => {
    if (!n || typeof n === "string") return null;
    if (Array.isArray(n)) { for (const c of n) { const r = walk(c); if (r) return r; } return null; }
    if (n.props?.["data-testid"] === id) return { props: n.props as Record<string, any> };
    return walk(n.children as Node[] | null);
  };
  return walk(tree as Node);
}
function seed() {
  setMockAppState({
    invoices: Array.from({ length: 60 }, (_, n) => ({
      id: `inv-${n}`, invoiceNumber: `INV-${n}`, status: "open", total: 10, balanceDue: 10,
      labOrganizationId: "lab-1", providerOrganization: { name: "Zenith" },
    })),
    meMemberships: [{ organizationId: "lab-1", role: "admin", status: "active", organization: { type: "lab" } }],
  });
}
function setup(os: string, width: number) {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true });
  vi.spyOn(RN, "useWindowDimensions").mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
}
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); resetMockAppState(); resetInvoiceRegisterSnapshotsForTests();
  Object.defineProperty(Platform, "OS", { value: original, configurable: true });
});

describe("wide web controls (1440)", () => {
  it("status select, Custom date/age sheet and page-size select", async () => {
    setup("web", 1440); seed();
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-wide-toolbar")).not.toBeNull();
    expect(screen.queryByTestId("invoice-page-size-50")).toBeNull();
    const dom = (id: string) => findDom(screen.toJSON(), id)!;

    await act(async () => { dom("invoice-select-status").props.onChange({ target: { value: "paid" } }); });
    expect(screen.getByTestId("invoice-tab-paid").props.accessibilityState.selected).toBe(true);
    expect(dom("invoice-select-status").props.value).toBe("paid");
    await act(async () => { dom("invoice-select-status").props.onChange({ target: { value: "all" } }); });
    expect(screen.getByTestId("invoice-tab-all").props.accessibilityState.selected).toBe(true);

    await act(async () => { dom("invoice-select-date").props.onChange({ target: { value: "custom" } }); });
    expect(screen.getByTestId("date-option-custom").props.accessibilityState?.checked).toBe(true);
    await fireEvent.press(screen.getByTestId("invoice-filters-cancel"));
    await act(async () => { dom("invoice-select-age").props.onChange({ target: { value: "custom" } }); });
    expect(screen.getByTestId("overdue-option-custom").props.accessibilityState?.checked).toBe(true);
  });

  it("page-size dropdown 25 to 50 resets the pager", async () => {
    setup("web", 1440); seed();
    const screen = await render(<InvoicesScreen />);
    await fireEvent.press(screen.getByTestId("invoice-page-2"));
    expect(screen.getByTestId("invoice-range").props.children.join("")).toContain("26-50 of 60");
    const sel = findDom(screen.toJSON(), "invoice-page-size-select")!;
    expect(sel.props.value).toBe("25");
    await act(async () => { sel.props.onChange({ target: { value: "50" } }); });
    expect(screen.getByTestId("invoice-range").props.children.join("")).toContain("1-50 of 60");
  });

  it("native at 1440 renders no DOM selects", async () => {
    setup("ios", 1440); seed();
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-wide-toolbar")).toBeNull();
    expect(findDom(screen.toJSON(), "invoice-select-status")).toBeNull();
    expect(screen.queryByTestId("invoice-pager")).toBeNull();
  });
});
