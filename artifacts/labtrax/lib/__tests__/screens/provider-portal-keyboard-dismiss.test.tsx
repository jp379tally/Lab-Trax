import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import { showMockKeyboard, isMockKeyboardVisible } from "../../../vitest.setup";
import { PayMyBillSheet } from "@/components/provider-portal/billing/PayMyBillSheet";
import type { ProviderStatement } from "@/lib/provider-billing";
import type { StatementInvoice } from "@/lib/provider-portal-billing";

/**
 * The provider portal's amount fields are the one place in the portal a static
 * check cannot finish the argument: the Pay My Bill sheet is a Modal, so it
 * renders in its own touch tree and the portal's dismissal layer never reaches
 * it. The sheet has to close the keyboard itself, and it has to do that without
 * closing the sheet or discarding the amount the provider just typed.
 */

const STATEMENT: ProviderStatement = {
  id: "stmt-1",
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  labName: "Bright Dental Lab",
  statementDate: "2026-09-01",
  totalAmount: "400.00",
  balanceDue: "250.00",
  invoiceCount: 1,
  invoiceIds: ["inv-1"],
};

const INVOICES: StatementInvoice[] = [
  {
    id: "inv-1",
    invoiceNumber: "1001",
    status: "sent",
    total: "400.00",
    balanceDue: "250.00",
    issuedAt: "2026-08-01T00:00:00.000Z",
  },
];

// The dismissal layer is deliberately inert until a keyboard is actually up.
async function openKeyboard(): Promise<void> {
  await act(() => {
    showMockKeyboard();
  });
  expect(isMockKeyboardVisible()).toBe(true);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Pay My Bill sheet — keyboard dismissal inside the modal", () => {
  async function renderSheet() {
    const onClose = vi.fn();
    const onSettled = vi.fn();
    const onLaunched = vi.fn();
    const screen = await render(
      <PayMyBillSheet
        statement={STATEMENT}
        invoices={INVOICES}
        onClose={onClose}
        onSettled={onSettled}
        onLaunched={onLaunched}
      />,
    );
    return { ...screen, onClose, onSettled, onLaunched };
  }

  it("closes the keyboard on a tap in the sheet, keeping the sheet and the amount", async () => {
    const { getByTestId, onClose } = await renderSheet();

    await fireEvent.press(getByTestId("pay-my-bill-mode-partial"));
    const amount = getByTestId("pay-my-bill-partial-amount");
    await fireEvent.changeText(amount, "125.50");
    await openKeyboard();

    await fireEvent.press(getByTestId("pay-my-bill-keyboard-dismiss"));

    expect(isMockKeyboardVisible()).toBe(false);
    // The sheet stays open and keeps what was typed: dismissing the keyboard
    // must not read as a backdrop tap.
    expect(onClose).not.toHaveBeenCalled();
    expect(getByTestId("pay-my-bill-partial-amount").props.value).toBe("125.50");
  });

  it("leaves the close button working after the keyboard is dismissed", async () => {
    const { getByTestId, onClose } = await renderSheet();

    await fireEvent.press(getByTestId("pay-my-bill-mode-partial"));
    await fireEvent.changeText(getByTestId("pay-my-bill-partial-amount"), "40");
    await openKeyboard();
    await fireEvent.press(getByTestId("pay-my-bill-keyboard-dismiss"));

    // A single tap on the close control still closes: the dismissal layer
    // never takes the first tap meant for a child.
    await fireEvent.press(getByTestId("pay-my-bill-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drags the keyboard away on the sheet's own scrollable", async () => {
    const { getByTestId } = await renderSheet();

    await fireEvent.press(getByTestId("pay-my-bill-mode-partial"));
    await fireEvent.changeText(getByTestId("pay-my-bill-partial-amount"), "75");
    await openKeyboard();

    // The drag handler is only wrapped on the host node, so the scrollable has
    // to be fetched by testID rather than by component type.
    const body = getByTestId("pay-my-bill-body");
    expect(["interactive", "on-drag"]).toContain(body.props.keyboardDismissMode);
    // Submit sits under the keyboard: taps must reach it rather than being
    // eaten by the scroll view's own dismissal.
    expect(body.props.keyboardShouldPersistTaps).toBe("handled");

    await fireEvent(body, "scrollBeginDrag", {
      nativeEvent: { contentOffset: { x: 0, y: 24 } },
    });

    expect(isMockKeyboardVisible()).toBe(false);
  });
});
