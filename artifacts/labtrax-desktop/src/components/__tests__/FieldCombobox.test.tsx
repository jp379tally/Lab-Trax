/** @vitest-environment jsdom */
/**
 * Unit tests for FieldCombobox.
 *
 * NOTE: FieldCombobox renders its dropdown via createPortal into document.body,
 * so option queries use document.body / document.querySelectorAll, not `container`.
 *
 * Invariants protected:
 *  - Opening the dropdown with a pre-filled value shows ALL suggestions, not
 *    just the matching one (the key regression this guards).
 *  - Typing filters suggestions to matching entries.
 *  - Selecting a suggestion calls onChange with the new value and closes the dropdown.
 *  - "Add new" row appears when the user has typed a value not in the list,
 *    and does NOT appear when a value was merely pre-filled programmatically.
 *  - Keyboard navigation (ArrowDown/Up, Enter, Escape) works correctly.
 */

import { render, fireEvent, act } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import { FieldCombobox } from "../FieldCombobox";

const SUGGESTIONS = ["Zirconia", "PFM", "Emax", "Full Cast Gold", "Acrylic"];

/** Options are portaled into document.body — query there. */
function getOptions() {
  return Array.from(document.querySelectorAll('[role="option"]'));
}

function getOptionLabels() {
  return getOptions().map((el) => el.textContent?.trim() ?? "");
}

function renderCombobox(props: Partial<Parameters<typeof FieldCombobox>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(
    <FieldCombobox
      value=""
      suggestions={SUGGESTIONS}
      onChange={onChange}
      placeholder="Select material…"
      addNewLabel="Add material"
      {...props}
    />,
  );
  const input = result.container.querySelector<HTMLInputElement>("input")!;
  return { ...result, input, onChange };
}

// ─── Core: pre-filled value does not filter the list ──────────────────────────

describe("FieldCombobox — pre-filled value shows full list on open", () => {
  it("shows all suggestions when opened with a pre-filled value (AI-filled scenario)", () => {
    const { input } = renderCombobox({ value: "Zirconia" });

    expect(input.value).toBe("Zirconia");

    fireEvent.focus(input);

    const labels = getOptionLabels();
    for (const suggestion of SUGGESTIONS) {
      expect(labels.some((l) => l === suggestion)).toBe(true);
    }
  });

  it("does NOT show 'Add new' when the dropdown is opened with a pre-filled exact match", () => {
    const onCreate = vi.fn().mockResolvedValue("Zirconia");
    const { input } = renderCombobox({ value: "Zirconia", onCreate });

    fireEvent.focus(input);

    const addNew = getOptions().find((el) => el.textContent?.includes("Add material"));
    expect(addNew).toBeUndefined();
  });

  it("retains the pre-filled value in the input while showing all options", () => {
    const { input } = renderCombobox({ value: "Crown & Bridge" });
    expect(input.value).toBe("Crown & Bridge");
    fireEvent.focus(input);
    expect(input.value).toBe("Crown & Bridge");
  });

  it("shows all options even when pre-filled value exactly matches one suggestion", () => {
    const { input } = renderCombobox({ value: "PFM" });
    fireEvent.focus(input);

    const labels = getOptionLabels();
    // All 5 suggestions should appear (not just PFM).
    expect(labels.filter((l) => SUGGESTIONS.includes(l)).length).toBe(SUGGESTIONS.length);
  });
});

// ─── Typing filters the list ──────────────────────────────────────────────────

describe("FieldCombobox — typing filters suggestions", () => {
  it("filters suggestions when the user types", () => {
    const { input } = renderCombobox();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Zir" } });

    const labels = getOptionLabels();
    expect(labels.some((l) => l === "Zirconia")).toBe(true);
    expect(labels.some((l) => l === "PFM")).toBe(false);
    expect(labels.some((l) => l === "Emax")).toBe(false);
  });

  it("shows all suggestions when typing is cleared after a filter", () => {
    const { input } = renderCombobox();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Zir" } });
    fireEvent.change(input, { target: { value: "" } });

    const labels = getOptionLabels().filter((l) => SUGGESTIONS.includes(l));
    expect(labels.length).toBe(SUGGESTIONS.length);
  });

  it("shows 'Add new' row when typed value has no exact match", () => {
    const onCreate = vi.fn().mockResolvedValue("Porcelain");
    const { input } = renderCombobox({ onCreate });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Porcelain" } });

    const addNew = getOptions().find((el) => el.textContent?.includes("Add material"));
    expect(addNew).toBeDefined();
  });

  it("does NOT show 'Add new' row when typed value exactly matches a suggestion", () => {
    const onCreate = vi.fn().mockResolvedValue("Zirconia");
    const { input } = renderCombobox({ onCreate });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Zirconia" } });

    const addNew = getOptions().find((el) => el.textContent?.includes("Add material"));
    expect(addNew).toBeUndefined();
  });
});

// ─── Punctuation-insensitive matching ─────────────────────────────────────────

describe("FieldCombobox — punctuation-insensitive matching", () => {
  const PUNCT_SUGGESTIONS = [
    "Zirconia Crown",
    "Custom E.max Inlay",
    "E.max Crown",
    "E.max",
    "3-Unit Bridge",
  ];

  function renderPunct(props: Partial<Parameters<typeof FieldCombobox>[0]> = {}) {
    return renderCombobox({ suggestions: PUNCT_SUGGESTIONS, ...props });
  }

  it('surfaces "E.max" suggestions when the user types "ema"', () => {
    const { input } = renderPunct();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ema" } });

    const labels = getOptionLabels();
    expect(labels).toContain("E.max");
    expect(labels).toContain("E.max Crown");
    expect(labels).not.toContain("Zirconia Crown");
  });

  it("ignores punctuation the user types", () => {
    const { input } = renderPunct();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "3 unit" } });

    expect(getOptionLabels()).toEqual(["3-Unit Bridge"]);
  });

  it("ranks exact, then prefix, then incidental matches", () => {
    const { input } = renderPunct();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "emax" } });

    expect(getOptionLabels()).toEqual([
      "E.max",
      "E.max Crown",
      "Custom E.max Inlay",
    ]);
  });

  it("does NOT offer 'Add new' for a punctuation-only difference", () => {
    const onCreate = vi.fn().mockResolvedValue("E.max Crown");
    const { input } = renderPunct({ onCreate });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "emax crown" } });

    const addNew = getOptions().find((el) => el.textContent?.includes("Add material"));
    expect(addNew).toBeUndefined();
  });

  it("still offers 'Add new' for a genuinely new value", () => {
    const onCreate = vi.fn().mockResolvedValue("Porcelain");
    const { input } = renderPunct({ onCreate });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Porcelain" } });

    const addNew = getOptions().find((el) => el.textContent?.includes("Add material"));
    expect(addNew).toBeDefined();
  });

  it("Enter on a punctuation-different match picks the stored spelling", () => {
    const { input, onChange } = renderPunct();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "emax crown" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith("E.max Crown");
  });
});

// ─── Selection ────────────────────────────────────────────────────────────────

describe("FieldCombobox — selecting a suggestion", () => {
  it("calls onChange with the selected value", () => {
    const { input, onChange } = renderCombobox({ value: "Zirconia" });

    fireEvent.focus(input);

    const pfmOption = getOptions().find((el) => el.textContent?.trim() === "PFM");
    expect(pfmOption).toBeDefined();
    fireEvent.mouseDown(pfmOption!);

    expect(onChange).toHaveBeenCalledWith("PFM");
  });

  it("closes the dropdown after a selection", () => {
    const { input } = renderCombobox({ value: "Zirconia" });

    fireEvent.focus(input);
    expect(getOptions().length).toBeGreaterThan(0);

    const option = getOptions()[0];
    fireEvent.mouseDown(option);

    expect(getOptions().length).toBe(0);
  });

  it("updates the input to the selected value", () => {
    const { input } = renderCombobox({ value: "Zirconia" });

    fireEvent.focus(input);

    const pfmOption = getOptions().find((el) => el.textContent?.trim() === "PFM");
    fireEvent.mouseDown(pfmOption!);

    expect(input.value).toBe("PFM");
  });

  it("shows full list again if the input is re-focused after selection", () => {
    const { input } = renderCombobox({ value: "Zirconia" });

    fireEvent.focus(input);
    const pfmOption = getOptions().find((el) => el.textContent?.trim() === "PFM");
    fireEvent.mouseDown(pfmOption!);

    // Re-open.
    fireEvent.focus(input);

    const labels = getOptionLabels().filter((l) => SUGGESTIONS.includes(l));
    expect(labels.length).toBe(SUGGESTIONS.length);
  });
});

// ─── "Add new" functionality ──────────────────────────────────────────────────

describe("FieldCombobox — Add new row", () => {
  it("calls onCreate with the typed value and updates input on success", async () => {
    const onCreate = vi.fn().mockResolvedValue("Porcelain");
    const { input, onChange } = renderCombobox({ onCreate });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Porcelain" } });

    const addNew = getOptions().find((el) => el.textContent?.includes("Add material"))!;
    expect(addNew).toBeDefined();

    await act(async () => {
      fireEvent.mouseDown(addNew);
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(onCreate).toHaveBeenCalledWith("Porcelain");
    expect(onChange).toHaveBeenCalledWith("Porcelain");
    expect(input.value).toBe("Porcelain");
  });
});

// ─── Keyboard navigation ──────────────────────────────────────────────────────

describe("FieldCombobox — keyboard navigation", () => {
  it("Escape closes the dropdown", () => {
    const { input } = renderCombobox();

    fireEvent.focus(input);
    expect(getOptions().length).toBeGreaterThan(0);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(getOptions().length).toBe(0);
  });

  it("ArrowDown opens the dropdown when closed", () => {
    const { input } = renderCombobox();

    fireEvent.focus(input);
    // Close it first.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(getOptions().length).toBe(0);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(getOptions().length).toBeGreaterThan(0);
  });

  it("Enter selects the single filtered match", () => {
    const { input, onChange } = renderCombobox();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Full Cast Gold" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("Full Cast Gold");
  });
});

// ─── Value sync from parent ───────────────────────────────────────────────────

describe("FieldCombobox — value prop sync", () => {
  it("updates the input when the value prop changes", () => {
    const { input, rerender } = renderCombobox({ value: "Zirconia" });
    expect(input.value).toBe("Zirconia");

    rerender(
      <FieldCombobox
        value="Emax"
        suggestions={SUGGESTIONS}
        onChange={vi.fn()}
        placeholder="Select material…"
        addNewLabel="Add material"
      />,
    );

    expect(input.value).toBe("Emax");
  });

  it("shows full list when opened after value prop change (new AI fill)", () => {
    const { input, rerender } = renderCombobox({ value: "" });

    rerender(
      <FieldCombobox
        value="Emax"
        suggestions={SUGGESTIONS}
        onChange={vi.fn()}
        placeholder="Select material…"
        addNewLabel="Add material"
      />,
    );

    fireEvent.focus(input);

    const labels = getOptionLabels().filter((l) => SUGGESTIONS.includes(l));
    expect(labels.length).toBe(SUGGESTIONS.length);
  });
});
