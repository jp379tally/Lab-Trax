import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Platform } from "react-native";
import { router } from "expo-router";
import {
  resetMockAppState,
  setMockAppState,
  setMockSearchParams,
} from "../../../vitest.setup";
import CaseDetailScreen from "@/app/case/[id]";
import { completedCaseWithInvoice, sampleInvoice } from "./__fixtures__/cases";

// The sheet is "opened" exactly when the auto-open effect consumes the param.
const sheetOpen = (_s?: unknown): boolean =>
  vi.mocked(router.setParams).mock.calls.length > 0;

const original = Platform.OS;
const open = { ...sampleInvoice, status: "open", balanceDue: 500 };
const admin = [{ organizationId: "org-1", role: "owner", status: "active" }];
const viewer = [{ organizationId: "org-1", role: "read_only", status: "active" }];

function setup(os: string, params: Record<string, string>, invoice = open, memberships = admin) {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true });
  setMockSearchParams({ id: completedCaseWithInvoice.id, ...params });
  setMockAppState({ cases: [{ ...completedCaseWithInvoice, organizationId: "org-1", labOrganizationId: "org-1" }], invoices: [invoice], meMemberships: memberships });
}

beforeEach(() => resetMockAppState());
afterEach(() => {
  cleanup();
  Object.defineProperty(Platform, "OS", { value: original, configurable: true });
  vi.clearAllMocks();
});

describe("case payment deep link (web only)", () => {
  it("web: opens invoice section and the payment sheet for the matching invoice", async () => {
    setup("web", { recordPaymentInvoiceId: open.id });
    const s = await render(<CaseDetailScreen />);
    await waitFor(() => expect(sheetOpen(s)).toBe(true));
    expect(router.setParams).toHaveBeenCalledWith({ recordPaymentInvoiceId: undefined });
    expect(s.getByTestId("section-tab-invoice").props.accessibilityState.selected).toBe(true);
    setMockSearchParams({ id: completedCaseWithInvoice.id });
    await s.rerender(<CaseDetailScreen />);
    expect(s.getByTestId("section-tab-invoice").props.accessibilityState.selected).toBe(true);
    await fireEvent.press(s.getByTestId("section-tab-notes"));
    await s.rerender(<CaseDetailScreen />);
    expect(s.getByTestId("section-tab-notes").props.accessibilityState.selected).toBe(true);
  });
  it("native ignores the param: stays on Overview, no sheet", async () => {
    setup("ios", { recordPaymentInvoiceId: open.id });
    const s = await render(<CaseDetailScreen />);
    expect(sheetOpen(s)).toBe(false);
    expect(s.queryByTestId("record-payment")).toBeNull();
    expect(s.getByTestId("section-tab-overview").props.accessibilityState.selected).toBe(true);
  });
  it("web: a reused route gives an explicit payment destination precedence for the new case", async () => {
    setup("web", {});
    const s = await render(<CaseDetailScreen />);
    await fireEvent.press(s.getByTestId("section-tab-files"));
    const nextCase = { ...completedCaseWithInvoice, id: "payment-case-b", organizationId: "org-1", labOrganizationId: "org-1" };
    setMockAppState({ cases: [nextCase], invoices: [{ ...open, caseId: nextCase.id }] });
    setMockSearchParams({ id: nextCase.id, recordPaymentInvoiceId: open.id });
    await s.rerender(<CaseDetailScreen />);
    expect(s.getByTestId("section-tab-invoice").props.accessibilityState.selected).toBe(true);
    await waitFor(() => expect(sheetOpen(s)).toBe(true));
  });
  it("web: unmatched invoice id does not open the sheet", async () => {
    setup("web", { recordPaymentInvoiceId: "other" });
    const s = await render(<CaseDetailScreen />);
    expect(sheetOpen(s)).toBe(false);
  });
  it("web: frozen or zero-balance invoices never auto-open", async () => {
    setup("web", { recordPaymentInvoiceId: open.id }, { ...open, frozen: true } as typeof open);
    expect(sheetOpen(await render(<CaseDetailScreen />))).toBe(false);
    cleanup();
    vi.mocked(router.setParams).mockClear();
    setup("web", { recordPaymentInvoiceId: open.id }, { ...open, balanceDue: 0 });
    expect(sheetOpen(await render(<CaseDetailScreen />))).toBe(false);
  });
  it("web: read-only users and paid invoices never auto-open", async () => {
    setup("web", { recordPaymentInvoiceId: open.id }, open, viewer);
    expect(sheetOpen(await render(<CaseDetailScreen />))).toBe(false);
    cleanup();
    vi.mocked(router.setParams).mockClear();
    setup("web", { recordPaymentInvoiceId: sampleInvoice.id }, sampleInvoice, admin);
    expect(sheetOpen(await render(<CaseDetailScreen />))).toBe(false);
  });
});
