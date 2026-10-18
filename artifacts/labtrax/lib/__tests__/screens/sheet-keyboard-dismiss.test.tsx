import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Keyboard } from "react-native";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { showMockKeyboard, isMockKeyboardVisible } from "../../../vitest.setup";
import { BillableItemPicker } from "@/components/BillableItemPicker";
import { SuggestionInput } from "@/components/ui/SuggestionInput";
import { TextField } from "@/components/ui/TextField";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";

/**
 * Representative cover for the shared sheets that host inputs, plus the shared
 * autocomplete they filter with.
 *
 * The sheets are the risky half of the rollout: they sit inside a backdrop that
 * closes them, so the tap that closes the keyboard must be swallowed by the
 * sheet body and must NOT reach that backdrop. The autocomplete is the other
 * half: its suggestion rows are the classic victim of a keyboard-dismissing
 * layer eating the first tap.
 */

const ITEMS = [
  { id: "item-1", priceKey: "crown", name: "Zirconia Crown", unitPrice: "120.00" },
  { id: "item-2", priceKey: "bridge", name: "3-Unit Bridge", unitPrice: "340.00" },
];

// The dismissal layer is only armed while a keyboard is actually up.
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

describe("Shared sheets — keyboard dismissal", () => {
  async function renderPicker() {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const screen = await render(
      <BillableItemPicker
        visible
        items={ITEMS}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("billable-item-picker-search")).toBeTruthy(),
    );
    return { ...screen, onSelect, onClose };
  }

  it("closes the keyboard on a tap inside the sheet without closing the sheet", async () => {
    const { getByTestId, onClose } = await renderPicker();

    await fireEvent.changeText(getByTestId("billable-item-picker-search"), "crown");
    await openKeyboard();

    await fireEvent.press(getByTestId("billable-item-picker-sheet"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    // The sheet stays open and the search term is untouched.
    expect(onClose).not.toHaveBeenCalled();
    expect(getByTestId("billable-item-picker-search").props.value).toBe("crown");
  });

  it("leaves the backdrop closing the sheet, exactly as before", async () => {
    const { getByTestId, onClose } = await renderPicker();
    await openKeyboard();

    await fireEvent.press(getByTestId("billable-item-picker-backdrop"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the keyboard when the option list is dragged", async () => {
    const { getByTestId } = await renderPicker();
    await openKeyboard();

    const list = getByTestId("billable-item-picker-list");
    expect(["interactive", "on-drag"]).toContain(list.props.keyboardDismissMode);
    expect(list.props.keyboardShouldPersistTaps).toBe("handled");

    await fireEvent(list, "scrollBeginDrag", {
      nativeEvent: { contentOffset: { x: 0, y: 24 } },
    });

    expect(isMockKeyboardVisible()).toBe(false);
  });

  it("still picks an option on the first tap while the keyboard is up", async () => {
    const { getByTestId, onSelect, onClose } = await renderPicker();
    await openKeyboard();

    await fireEvent.press(getByTestId("billable-item-picker-item-item-2"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-2", label: "3-Unit Bridge" }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SuggestionInput — keyboard dismissal", () => {
  async function renderSuggestionInput(value = "") {
    const onChangeText = vi.fn();
    // Rendered under the same layer the sheets and screens now use, so the
    // suggestion rows have to win the tap against it.
    const screen = await render(
      <DismissKeyboardView testID="suggestion-host-dismiss">
        <SuggestionInput
          value={value}
          onChangeText={onChangeText}
          suggestions={["Zirconia Crown", "3-Unit Bridge"]}
          testID="suggestion-field"
        />
      </DismissKeyboardView>,
    );
    await waitFor(() => expect(screen.getByTestId("suggestion-field")).toBeTruthy());
    return { ...screen, onChangeText };
  }

  it("applies a suggestion on the first tap while the keyboard is open", async () => {
    const { getByTestId, onChangeText } = await renderSuggestionInput();

    await fireEvent(getByTestId("suggestion-field"), "focus");
    await fireEvent.changeText(getByTestId("suggestion-field"), "zirc");
    await openKeyboard();

    await fireEvent.press(getByTestId("suggestion-Zirconia Crown"));

    // One tap, one applied suggestion — the dismissal layer never intercepts it.
    expect(onChangeText).toHaveBeenLastCalledWith("Zirconia Crown");
  });

  it("closes the keyboard from the return key, keeping the typed value", async () => {
    const { getByTestId } = await renderSuggestionInput("zirc");
    await openKeyboard();

    const input = getByTestId("suggestion-field");
    // Single line, so the return key blurs (and the keyboard goes with it)
    // rather than doing nothing.
    expect(input.props.submitBehavior).toBe("blurAndSubmit");
    expect(input.props.multiline).toBeFalsy();

    await fireEvent(input, "submitEditing");

    expect(input.props.value).toBe("zirc");
  });
});

describe("TextField — return-key behaviour", () => {
  it("blurs a single-line field on submit, closing the keyboard with it", async () => {
    const { getByTestId } = await render(
      <TextField label="Name" value="Crown" onChangeText={() => undefined} testID="single" />,
    );
    expect(getByTestId("single").props.submitBehavior).toBe("blurAndSubmit");
  });

  it("keeps the newline on a multi-line field", async () => {
    const { getByTestId } = await render(
      <TextField
        label="Notes"
        multiline
        value="line one"
        onChangeText={() => undefined}
        testID="multi"
      />,
    );
    expect(getByTestId("multi").props.submitBehavior).toBe("newline");
  });

  it("lets a caller override the return-key behaviour", async () => {
    const { getByTestId } = await render(
      <TextField
        label="Search"
        value=""
        onChangeText={() => undefined}
        submitBehavior="submit"
        testID="override"
      />,
    );
    expect(getByTestId("override").props.submitBehavior).toBe("submit");
  });
});
