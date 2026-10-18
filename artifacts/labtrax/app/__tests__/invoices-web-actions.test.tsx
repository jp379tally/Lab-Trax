import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import { Platform } from "react-native";
import InvoicesScreen, { resetInvoiceRegisterSnapshotsForTests } from "@/app/finance/invoices";
import { isInvoiceOverdue } from "@/lib/invoice-web-fields";
import { invoiceBadgeVariant } from "@/components/invoices-web/InvoiceRegisterRow";
import { emitMockCacheInvalidate, resetMockFetchHandler, setMockFetchHandler, resetMockAppState, setMockAppState } from "../../vitest.setup";

const original = Platform.OS;
const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
function seed(role = "admin", extra: Record<string, unknown> = {}, count = 1) {
  setMockAppState({
    invoices: Array.from({ length: count }, (_, n) => ({
      id: `i${n}`, invoiceNumber: `INV-${n}`, status: "open", total: 100, balanceDue: 100, caseId: "case-1", dueAt: past,
      labOrganizationId: "lab-1", providerOrganization: { name: "Zenith" }, ...extra,
    })),
    meMemberships: [{ organizationId: "lab-1", role, status: "active", organization: { type: "lab" } }],
  });
}
afterEach(() => {
  cleanup(); resetMockAppState(); resetInvoiceRegisterSnapshotsForTests();
  Object.defineProperty(Platform, "OS", { value: original, configurable: true });
  resetMockFetchHandler(); vi.unstubAllGlobals(); vi.clearAllMocks();
});
const web = () => Object.defineProperty(Platform, "OS", { value: "web", configurable: true });

describe("web register row actions", () => {
  it("does not give partially paid invoices the fully paid badge", () => {
    expect(invoiceBadgeVariant("partially_paid")).toBe("open");
    expect(invoiceBadgeVariant("paid")).toBe("paid");
    expect(invoiceBadgeVariant("draft")).toBe("draft");
  });

  it("View, Edit and More are distinct and do not trigger row selection twice", async () => {
    web(); seed();
    const screen = await render(<InvoicesScreen />);
    await fireEvent.press(screen.getByTestId("invoice-edit-i0"));
    expect(router.push).toHaveBeenCalledWith("/invoice-editor/i0");
    expect(screen.queryByTestId("invoice-detail-panel")).toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-more-i0"));
    await fireEvent.press(screen.getByTestId("invoice-menu-payment-i0"));
    expect(router.push).toHaveBeenCalledWith("/case/case-1?recordPaymentInvoiceId=i0");
    await fireEvent.press(screen.getByTestId("invoice-view-i0"));
    expect(screen.queryByTestId("invoice-detail-panel")).not.toBeNull();
  });

  it("read-only roles get no Edit or payment operation", async () => {
    web(); seed("technician");
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-edit-i0")).toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-more-i0"));
    expect(screen.queryByTestId("invoice-menu-payment-i0")).toBeNull();
    expect(screen.queryByTestId("invoice-menu-edit-i0")).toBeNull();
    expect(screen.queryByTestId("invoice-menu-details-i0")).not.toBeNull();
  });

  it("keeps drafts viewable without opening an editor that would change their status", async () => {
    web(); seed("admin", { status: "draft" });
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-edit-i0")).toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-view-i0"));
    expect(screen.queryByTestId("invoice-detail-edit")).toBeNull();
    expect(screen.getByText(/Draft invoices are read-only here/)).not.toBeNull();
  });

  it("frozen invoices hide Edit; overdue rule is status/balance/frozen aware", async () => {
    web(); seed("admin", { frozen: true });
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-edit-i0")).toBeNull();
    const base = { status: "open", total: 5, balanceDue: 5, dueAt: past } as never;
    expect(isInvoiceOverdue(base)).toBe(true);
    expect(isInvoiceOverdue({ ...(base as object), status: "paid" } as never)).toBe(false);
    expect(isInvoiceOverdue({ ...(base as object), balanceDue: 0 } as never)).toBe(false);
    expect(isInvoiceOverdue({ ...(base as object), frozen: true } as never)).toBe(false);
  });

  it.each(["draft", "recovery_draft"])("web %s rows are read-only: no Edit, no payment, notice shown", async (status) => {
    web(); seed("admin", { status });
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-edit-i0")).toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-more-i0"));
    expect(screen.queryByTestId("invoice-menu-edit-i0")).toBeNull();
    expect(screen.queryByTestId("invoice-menu-payment-i0")).toBeNull();
    expect(screen.queryByTestId("invoice-menu-readonly-i0")).not.toBeNull();
  });

  it("native keeps its own row behaviour for recovery drafts (no web register row)", async () => {
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    seed("admin", { status: "recovery_draft" });
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-more-i0")).toBeNull();
    expect(screen.queryByTestId("invoice-i0")).not.toBeNull();
  });

  it("invalidating invoices resets the pager to page 1", async () => {
    web(); seed("admin", {}, 60);
    const screen = await render(<InvoicesScreen />);
    await fireEvent.press(screen.getByTestId("invoice-page-2"));
    expect(screen.queryByTestId("invoice-i0")).toBeNull();
    await act(async () => { emitMockCacheInvalidate("invoices"); });
    expect(screen.queryByTestId("invoice-i0")).not.toBeNull();
  });

  it("export failure shows an error and cancel stops a running export", async () => {
    web(); seed();
    let release: (v: unknown) => void = () => {};
    const fetchMock = vi.fn((_u: string, init?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      release = resolve;
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    setMockFetchHandler(fetchMock as never);
    const screen = await render(<InvoicesScreen />);
    await fireEvent.press(screen.getByTestId("invoice-export"));
    expect(screen.queryByTestId("invoice-export-cancel")).not.toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-export-cancel"));
    await act(async () => {});
    expect(screen.queryByTestId("invoice-export")).not.toBeNull();
    expect(screen.queryByTestId("invoice-export-error")).toBeNull();
    void release;
    setMockFetchHandler((async () => new Response(JSON.stringify({ rows: [], total: 5, hasMore: false }), { status: 200 })) as never);
    await fireEvent.press(screen.getByTestId("invoice-export"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("invoice-export-error")).not.toBeNull();
  });
});
