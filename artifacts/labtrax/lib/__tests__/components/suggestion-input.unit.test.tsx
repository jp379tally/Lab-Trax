/**
 * Unit tests for SuggestionInput.
 *
 * Key invariant: when the field has a pre-filled value (e.g. supplied by AI),
 * focusing it must show the FULL suggestion list — not a list narrowed by the
 * current value.  The user should be able to browse all options and pick
 * something different without having to clear the field first.
 *
 * The vitest.setup.ts global mocks already cover react-native, safe-area-context,
 * vector-icons, and theme-context, so no extra vi.mock() calls are needed.
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";

import { SuggestionInput } from "@/components/ui/SuggestionInput";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SUGGESTIONS = ["Crown", "Bridge", "Veneer", "Implant", "Denture"];

async function renderInput(
  overrides: Partial<React.ComponentProps<typeof SuggestionInput>> = {},
) {
  const onChangeText = vi.fn();
  const utils = await render(
    <SuggestionInput
      value=""
      onChangeText={onChangeText}
      suggestions={SUGGESTIONS}
      testID="suggestion-input"
      {...overrides}
    />,
  );
  return { ...utils, onChangeText };
}

// ─── Pre-filled value — full list on focus ─────────────────────────────────

describe("SuggestionInput — pre-filled value shows full list on focus", () => {
  it("shows all suggestions when focused with an AI-prefilled value", async () => {
    const { getByTestId } = await renderInput({ value: "Crown" });

    await fireEvent(getByTestId("suggestion-input"), "focus");

    // All suggestions must be visible, not just items containing "Crown".
    for (const s of SUGGESTIONS) {
      expect(getByTestId(`suggestion-${s}`)).toBeTruthy();
    }
  });

  it("shows all suggestions when focused with a partial pre-filled value that would otherwise filter", async () => {
    // "Cr" would match only "Crown" if filtering by value; must show all.
    const { getByTestId } = await renderInput({ value: "Cr" });

    await fireEvent(getByTestId("suggestion-input"), "focus");

    for (const s of SUGGESTIONS) {
      expect(getByTestId(`suggestion-${s}`)).toBeTruthy();
    }
  });

  it("shows all suggestions when focused with an empty value", async () => {
    const { getByTestId } = await renderInput({ value: "" });

    await fireEvent(getByTestId("suggestion-input"), "focus");

    for (const s of SUGGESTIONS) {
      expect(getByTestId(`suggestion-${s}`)).toBeTruthy();
    }
  });
});

// ─── Typing narrows the list ───────────────────────────────────────────────

describe("SuggestionInput — typing narrows the list after focus", () => {
  it("filters suggestions as the user types after focusing", async () => {
    const { getByTestId, queryByTestId } = await renderInput({ value: "Crown" });

    await fireEvent(getByTestId("suggestion-input"), "focus");
    // User types "br" — should narrow to Bridge only.
    await fireEvent.changeText(getByTestId("suggestion-input"), "br");

    expect(getByTestId("suggestion-Bridge")).toBeTruthy();
    expect(queryByTestId("suggestion-Crown")).toBeNull();
    expect(queryByTestId("suggestion-Veneer")).toBeNull();
  });

  it('surfaces "E.max"-style suggestions for a punctuation-free query', async () => {
    // Matching ignores punctuation/spacing on BOTH sides: "ema" must reach
    // "E.max Crown" and "3 unit" must reach "3-Unit Bridge".
    const { getByTestId, queryByTestId } = await renderInput({
      value: "",
      suggestions: ["Zirconia Crown", "E.max Crown", "3-Unit Bridge"],
    });

    await fireEvent(getByTestId("suggestion-input"), "focus");
    await fireEvent.changeText(getByTestId("suggestion-input"), "ema");

    expect(getByTestId("suggestion-E.max Crown")).toBeTruthy();
    expect(queryByTestId("suggestion-Zirconia Crown")).toBeNull();

    await fireEvent.changeText(getByTestId("suggestion-input"), "e.ma");
    expect(getByTestId("suggestion-E.max Crown")).toBeTruthy();

    await fireEvent.changeText(getByTestId("suggestion-input"), "3 unit");
    expect(getByTestId("suggestion-3-Unit Bridge")).toBeTruthy();
    expect(queryByTestId("suggestion-E.max Crown")).toBeNull();
  });

  it("lists an exact match before a mid-name match", async () => {
    const { getByTestId, getAllByTestId } = await renderInput({
      value: "",
      suggestions: ["Custom Emax Inlay", "E.max"],
      testID: "typeahead",
    });

    await fireEvent(getByTestId("typeahead"), "focus");
    await fireEvent.changeText(getByTestId("typeahead"), "emax");

    // Both match; the exact one must come first.
    expect(getAllByTestId(/^suggestion-/).map((n) => n.props.testID)).toEqual([
      "suggestion-E.max",
      "suggestion-Custom Emax Inlay",
    ]);
  });

  it("restores full list when the user clears what they typed (empty filterText)", async () => {
    const { getByTestId } = await renderInput({ value: "Crown" });

    await fireEvent(getByTestId("suggestion-input"), "focus");
    // Type something then clear.
    await fireEvent.changeText(getByTestId("suggestion-input"), "br");
    await fireEvent.changeText(getByTestId("suggestion-input"), "");

    // Back to full list.
    for (const s of SUGGESTIONS) {
      expect(getByTestId(`suggestion-${s}`)).toBeTruthy();
    }
  });
});

// ─── Selection ─────────────────────────────────────────────────────────────

describe("SuggestionInput — selecting a suggestion", () => {
  it("calls onChangeText with the selected value", async () => {
    const { getByTestId, onChangeText } = await renderInput({ value: "" });

    await fireEvent(getByTestId("suggestion-input"), "focus");
    await fireEvent.press(getByTestId("suggestion-Bridge"));

    expect(onChangeText).toHaveBeenCalledWith("Bridge");
  });

  it("closes the dropdown after selection", async () => {
    const { getByTestId, queryByTestId } = await renderInput({ value: "" });

    await fireEvent(getByTestId("suggestion-input"), "focus");
    await fireEvent.press(getByTestId("suggestion-Crown"));

    // Dropdown should be gone.
    expect(queryByTestId("suggestion-Bridge")).toBeNull();
  });

  it("re-opens with the full list on the next focus after a selection", async () => {
    const { getByTestId } = await renderInput({ value: "Crown" });

    await fireEvent(getByTestId("suggestion-input"), "focus");
    await fireEvent.press(getByTestId("suggestion-Bridge"));

    // Simulate the field now having value "Bridge" and user refocusing.
    await fireEvent(getByTestId("suggestion-input"), "focus");

    for (const s of SUGGESTIONS) {
      expect(getByTestId(`suggestion-${s}`)).toBeTruthy();
    }
  });
});

// ─── maxSuggestions cap ────────────────────────────────────────────────────

describe("SuggestionInput — maxSuggestions cap", () => {
  it("caps the number of suggestions shown to maxSuggestions", async () => {
    const many = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const { getByTestId, queryByTestId } = await renderInput({
      value: "",
      suggestions: many,
      maxSuggestions: 3,
    });

    await fireEvent(getByTestId("suggestion-input"), "focus");

    expect(getByTestId("suggestion-A")).toBeTruthy();
    expect(getByTestId("suggestion-B")).toBeTruthy();
    expect(getByTestId("suggestion-C")).toBeTruthy();
    expect(queryByTestId("suggestion-D")).toBeNull();
  });
});
