/** @vitest-environment jsdom */
/**
 * ItemCombobox — punctuation-insensitive item search.
 *
 * NOTE: the dropdown is portaled into document.body, so options are queried
 * from document.body rather than the render container.
 *
 * Invariants protected:
 *  - Typing "ema" surfaces "E.max Crown" (a plain substring match missed it).
 *  - The best match is listed first for a short query.
 *  - Picking the surfaced option still fills name + unit price.
 *  - A punctuation-only difference from an existing item does not offer to
 *    create a duplicate billable item.
 *  - Keyboard navigation: ArrowDown/ArrowUp move a visible highlight, Enter
 *    accepts the highlighted option (defaulting to the top-ranked match) and
 *    still falls through to "add as new billable item" when nothing matches,
 *    Escape closes the dropdown.
 */

import { render, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import { ItemCombobox, type ItemComboboxOption } from "../ItemCombobox";

const OPTIONS: ItemComboboxOption[] = [
  { key: "zir", name: "Zirconia Crown", unitPrice: 150, group: "catalog" },
  { key: "emax", name: "E.max Crown", unitPrice: 185, group: "catalog" },
  { key: "inlay", name: "Custom Emax Inlay", unitPrice: 120, group: "custom" },
  { key: "gold", name: "Full Cast Gold", unitPrice: 300, group: "catalog" },
];

function optionRows() {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="option"]'),
  );
}

function highlightedLabel() {
  return optionRows()
    .find((el) => el.getAttribute("aria-selected") === "true")
    ?.textContent?.trim();
}

function optionLabels() {
  return Array.from(document.body.querySelectorAll("button"))
    .map((el) => el.textContent?.trim() ?? "")
    .filter((t) => t.length > 0);
}

function renderCombobox(
  props: Partial<Parameters<typeof ItemCombobox>[0]> = {},
) {
  const onPick = vi.fn();
  const onText = vi.fn();
  const result = render(
    <ItemCombobox
      value=""
      options={OPTIONS}
      onPick={onPick}
      onText={onText}
      {...props}
    />,
  );
  const input = result.container.querySelector<HTMLInputElement>("input")!;
  return { ...result, input, onPick, onText };
}

describe("ItemCombobox — typing 'ema' finds the E.max crown", () => {
  it('surfaces "E.max Crown" and ranks it first', () => {
    const { input } = renderCombobox();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ema" } });

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("E.max Crown"))).toBe(true);
    // Prefix match ahead of the mid-name "Custom Emax Inlay" hit.
    expect(labels[0]).toContain("E.max Crown");
    // Non-matching options stay filtered out.
    expect(labels.some((l) => l.includes("Full Cast Gold"))).toBe(false);
  });

  it("fills the name and unit price when the surfaced option is picked", () => {
    const { input, onPick } = renderCombobox();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ema" } });
    const emaxBtn = Array.from(document.body.querySelectorAll("button")).find(
      (el) => el.textContent?.includes("E.max Crown"),
    )!;
    fireEvent.mouseDown(emaxBtn);

    expect(onPick).toHaveBeenCalledWith({
      name: "E.max Crown",
      unitPrice: 185,
    });
  });

  it("does not offer to create a duplicate when only punctuation differs", () => {
    const onCreate = vi.fn().mockResolvedValue(null);
    const { input } = renderCombobox({ onCreate });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "emax crown" } });

    expect(
      optionLabels().some((l) => l.startsWith("Add \u201c")),
    ).toBe(false);
  });

  it("still offers to create a genuinely new item", () => {
    const onCreate = vi.fn().mockResolvedValue(null);
    const { input } = renderCombobox({ onCreate });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Titanium Abutment" } });

    expect(optionLabels().some((l) => l.includes("Titanium Abutment"))).toBe(
      true,
    );
  });
});

describe("ItemCombobox — keyboard navigation", () => {
  it("Enter accepts the top-ranked match without touching the arrows", () => {
    const onCreate = vi.fn().mockResolvedValue(null);
    const { input, onPick } = renderCombobox({ onCreate });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ema" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith({
      name: "E.max Crown",
      unitPrice: 185,
    });
    // The best match wins over the "add as new billable item" shortcut.
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("ArrowDown moves a visible highlight through the matches", () => {
    const { input } = renderCombobox();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ema" } });
    expect(highlightedLabel()).toBeUndefined();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(highlightedLabel()).toContain("E.max Crown");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(highlightedLabel()).toContain("Custom Emax Inlay");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(highlightedLabel()).toContain("E.max Crown");
  });

  it("Enter picks the highlighted option, not just the first one", () => {
    const { input, onPick } = renderCombobox();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ema" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith({
      name: "Custom Emax Inlay",
      unitPrice: 120,
    });
  });

  it("Enter still adds a new billable item when nothing matches", () => {
    const onCreate = vi.fn().mockResolvedValue(null);
    const { input, onPick } = renderCombobox({ onCreate });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Titanium Abutment" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreate).toHaveBeenCalledWith("Titanium Abutment");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("ArrowDown opens the dropdown when it is closed", () => {
    const { input } = renderCombobox();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(optionRows().length).toBeGreaterThan(0);
  });

  it("Escape closes the dropdown", () => {
    const { input } = renderCombobox();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ema" } });
    expect(optionRows().length).toBeGreaterThan(0);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(optionRows().length).toBe(0);
  });
});
