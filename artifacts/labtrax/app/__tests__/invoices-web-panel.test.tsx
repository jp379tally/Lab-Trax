import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import { InvoiceDetailView } from "@/components/invoices-web/InvoiceDetailPanel";
import { InvoiceRegisterRow } from "@/components/invoices-web/InvoiceRegisterRow";
import { invoiceLayoutMode, paymentActionState, patientOf, doctorOf, toothOf, restorationOf } from "@/lib/invoice-web-fields";

afterEach(cleanup);

const inv: any = {
  id: "i1", invoiceNumber: "INV-1", status: "open", total: 46, balanceDue: 46, caseId: "c1",
  labOrganizationId: "lab-1", providerOrganization: { name: "Heartland" },
  displayMetadataJson: { patientName: "Victoria D", billTo: "Dr Selvan", teeth: "5", caseType: "Zirconia crown", material: "Zr" },
  lineItems: [{ id: "l", description: "Crown", toothLabel: "9" }],
};
const handlers = { onRetry: vi.fn(), onClose: vi.fn(), onEdit: vi.fn(), onRecordPayment: vi.fn() };
const view = (over: Record<string, unknown> = {}) =>
  render(<InvoiceDetailView invoice={inv} loading={false} error={false} canWrite {...handlers} {...over} />);

describe("field extraction", () => {
  it("reads metadata, line toothLabel and case fallbacks", () => {
    expect(patientOf(inv)).toBe("Victoria D");
    expect(doctorOf(inv)).toBe("Dr Selvan");
    expect(toothOf(inv)).toBe("5");
    expect(restorationOf(inv)).toBe("Zirconia crown · Zr");
    const bare: any = { id: "x", lineItems: [{ id: "l", toothNumber: 8 }] };
    expect(toothOf(bare)).toBe("8");
    expect(patientOf(bare, { patientFirstName: "Ann", patientLastName: "Lee" })).toBe("Ann Lee");
    expect(toothOf({ id: "y" } as any, { restorations: [{ toothNumber: "12", restorationType: "PFZ" }] })).toBe("12");
    expect(restorationOf({ id: "y" } as any, { restorations: [{ restorationType: "PFZ", material: "M" }] })).toBe("PFZ · M");
  });
});

describe("layout modes", () => {
  it("phone and tablet use a sheet, wide uses side panel", () => {
    expect(invoiceLayoutMode(375)).toBe("sheet");
    expect(invoiceLayoutMode(820)).toBe("sheet");
    expect(invoiceLayoutMode(1280)).toBe("side");
  });
});

describe("InvoiceDetailView", () => {
  it("renders authoritative metadata and both actions for writers", async () => {
    const s = await view();
    expect(s.getByText("Victoria D")).toBeTruthy();
    expect(s.getByText("Dr Selvan")).toBeTruthy();
    await fireEvent.press(s.getByTestId("invoice-detail-edit"));
    expect(handlers.onEdit).toHaveBeenCalledWith(inv);
    await fireEvent.press(s.getByTestId("invoice-detail-payment"));
    expect(handlers.onRecordPayment).toHaveBeenCalledWith(inv);
  });
  it("hides write actions for provider/read-only users", async () => {
    const s = await view({ canWrite: false });
    expect(s.queryByTestId("invoice-detail-edit")).toBeNull();
    expect(s.queryByTestId("invoice-detail-payment")).toBeNull();
    expect(s.queryByTestId("invoice-detail-body")).not.toBeNull();
  });
  it("hides edit when frozen and payment for frozen/void/paid/zero", async () => {
    expect((await view({ invoice: { ...inv, frozen: true } })).queryByTestId("invoice-detail-edit")).toBeNull();
    for (const patch of [{ frozen: true }, { status: "void" }, { status: "paid" }, { balanceDue: 0 }]) {
      expect(paymentActionState({ ...inv, ...patch }, true).visible).toBe(false);
    }
    expect(paymentActionState({ ...inv, caseId: null }, true)).toEqual({ visible: true, enabled: false });
  });
  it("loading, error with retry, missing, and stale-on-refresh-failure", async () => {
    expect((await view({ invoice: null, loading: true })).queryByTestId("invoice-detail-loading")).not.toBeNull();
    const e = await view({ invoice: null, error: true });
    await fireEvent.press(e.getByTestId("invoice-detail-retry"));
    expect(handlers.onRetry).toHaveBeenCalled();
    expect((await view({ invoice: null })).queryByTestId("invoice-detail-missing")).not.toBeNull();
    expect((await view({ error: true })).queryByTestId("invoice-detail-stale")).not.toBeNull();
  });
  it("shows fresh totals when the invoice prop updates after an edit", async () => {
    const s = await view();
    await s.rerender(<InvoiceDetailView invoice={{ ...inv, total: 80, balanceDue: 80 }} loading={false} error={false} canWrite {...handlers} />);
    expect(s.getByTestId("invoice-detail-balance").props.children).toBe("$80.00");
  });
  it("close control is an accessible button and fires onClose", async () => {
    const s = await view();
    const close = s.getByTestId("invoice-detail-close");
    expect(close.props.accessibilityRole).toBe("button");
    expect(close.props.accessibilityLabel).toBe("Close invoice detail");
    await fireEvent.press(close);
    expect(handlers.onClose).toHaveBeenCalled();
  });
});

describe("InvoiceRegisterRow", () => {
  it("groups practice/patient/restoration and marks selection", async () => {
    const s = await render(<InvoiceRegisterRow invoice={inv} selected onPress={() => {}} />);
    expect(s.getByText("Heartland")).toBeTruthy();
    expect(s.getByText("Victoria D")).toBeTruthy();
    expect(s.getByText("Zirconia crown · Zr · Tooth 5")).toBeTruthy();
    expect(s.getByTestId("invoice-i1").props.accessibilityState.selected).toBe(true);
  });
});

describe("stale detail safety", () => {
  it("hides write actions when a refresh failed or invoice is missing", async () => {
    const s = await view({ error: true });
    expect(s.queryByTestId("invoice-detail-stale")).not.toBeNull();
    expect(s.queryByTestId("invoice-detail-edit")).toBeNull();
    expect(s.queryByTestId("invoice-detail-payment")).toBeNull();
    const m = await view({ invoice: null, error: true });
    expect(m.queryByTestId("invoice-detail-edit")).toBeNull();
  });
});
