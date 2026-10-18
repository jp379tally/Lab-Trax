/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useInvoicePanelSize } from "@/hooks/useInvoicePanelSize";

const PANEL_WIDTH_KEY = "labtrax_invoice_panel_width_v1";
const PANEL_MAXIMIZED_KEY = "labtrax_invoice_panel_maximized_v1";

beforeEach(() => {
  localStorage.removeItem(PANEL_WIDTH_KEY);
  localStorage.removeItem(PANEL_MAXIMIZED_KEY);
});

describe("useInvoicePanelSize persistence", () => {
  it("remembers a dragged panel width after the editor is reopened", () => {
    const first = renderHook(() => useInvoicePanelSize());

    act(() => {
      first.result.current.onResizeMouseDown({
        preventDefault: () => undefined,
        clientX: 700,
      } as React.MouseEvent);
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 590 }));
      window.dispatchEvent(new MouseEvent("mouseup"));
    });

    expect(first.result.current.panelWidth).toBe(878);
    first.unmount();

    const reopened = renderHook(() => useInvoicePanelSize());
    expect(reopened.result.current.panelWidth).toBe(878);
  });

  it("remembers maximize state and restores the previously chosen width", () => {
    const first = renderHook(() => useInvoicePanelSize());
    act(() => first.result.current.toggleMaximized());
    expect(first.result.current.isMaximized).toBe(true);
    first.unmount();

    const reopened = renderHook(() => useInvoicePanelSize());
    expect(reopened.result.current.isMaximized).toBe(true);
    expect(reopened.result.current.panelWidth).toBe(768);

    act(() => reopened.result.current.toggleMaximized());
    expect(reopened.result.current.isMaximized).toBe(false);
    expect(reopened.result.current.panelWidth).toBe(768);
  });
});
