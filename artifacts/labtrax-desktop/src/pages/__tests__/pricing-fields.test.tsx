/** @vitest-environment jsdom */
/**
 * Regression suite: "Pricing Editor Two Decimal Display Protected"
 *
 * Guards:
 * - PriceField always shows two decimal places when the field is NOT focused:
 *   integer "119" → "119.00", single-decimal "99.5" → "99.50", already-formatted
 *   "119.00" stays "119.00", blank stays blank.
 * - While focused, PriceField shows the raw (un-formatted) value so typing is
 *   not disrupted.
 * - On blur, PriceField formats the current value and fires onChange with the
 *   formatted result.
 * - On Enter, PriceField formats the current value and fires onChange with the
 *   formatted result.
 * - Stored / calculated values are NEVER changed — only the display string
 *   rendered inside the <input> changes.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PriceField } from "@/pages/pricing";
import { makeAuthWrapper } from "../../__tests__/test-utils";

describe("PriceField — two-decimal display guard", () => {
  it("formats an integer value to two decimals when unfocused", () => {
    render(<PriceField label="Zirconia Crown" value="119" onChange={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    expect(screen.getByRole("textbox")).toHaveValue("119.00");
  });

  it("formats a single-decimal value to two decimals when unfocused", () => {
    render(<PriceField label="PFM Crown" value="99.5" onChange={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    expect(screen.getByRole("textbox")).toHaveValue("99.50");
  });

  it("passes through an already-formatted value unchanged when unfocused", () => {
    render(<PriceField label="Implant" value="119.00" onChange={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    expect(screen.getByRole("textbox")).toHaveValue("119.00");
  });

  it("shows an empty string for a blank value (no spurious formatting)", () => {
    render(<PriceField label="Crown" value="" onChange={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("shows the raw (unformatted) value while the field is focused", () => {
    render(<PriceField label="Crown" value="119" onChange={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    const input = screen.getByRole("textbox");

    expect(input).toHaveValue("119.00"); // unfocused — formatted

    fireEvent.focus(input);
    expect(input).toHaveValue("119"); // focused — raw
  });

  it("reverts to the formatted display after the field loses focus", () => {
    render(<PriceField label="Crown" value="119" onChange={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    const input = screen.getByRole("textbox");

    fireEvent.focus(input);
    expect(input).toHaveValue("119"); // focused — raw

    fireEvent.blur(input);
    expect(input).toHaveValue("119.00"); // unfocused again — formatted
  });

  it("fires onChange with the formatted value on blur", () => {
    const onChange = vi.fn();
    render(<PriceField label="Crown" value="99.5" onChange={onChange} />, {
      wrapper: makeAuthWrapper(),
    });
    const input = screen.getByRole("textbox");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "99.5" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith("99.50");
  });

  it("fires onChange with the formatted value when Enter is pressed", () => {
    const onChange = vi.fn();
    render(<PriceField label="Crown" value="99.5" onChange={onChange} />, {
      wrapper: makeAuthWrapper(),
    });
    const input = screen.getByRole("textbox");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "99.5" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith("99.50");
  });

  it("fires onChange with the raw value as the user types (no mid-type formatting)", () => {
    const onChange = vi.fn();
    render(<PriceField label="Crown" value="" onChange={onChange} />, {
      wrapper: makeAuthWrapper(),
    });
    const input = screen.getByRole("textbox");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith("1");

    fireEvent.change(input, { target: { value: "11" } });
    expect(onChange).toHaveBeenLastCalledWith("11");

    fireEvent.change(input, { target: { value: "119" } });
    expect(onChange).toHaveBeenLastCalledWith("119");
    // Not called with "119.00" during typing — only on blur or Enter.
    expect(onChange).not.toHaveBeenCalledWith("119.00");
  });

  it("uses the custom placeholder when provided", () => {
    render(
      <PriceField label="Crown" value="" onChange={vi.fn()} placeholder="0.00" />,
      { wrapper: makeAuthWrapper() },
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "0.00");
  });

  it("uses the tier price placeholder when provided", () => {
    render(
      <PriceField label="Crown" value="" onChange={vi.fn()} placeholder="95.00" />,
      { wrapper: makeAuthWrapper() },
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "95.00");
  });
});

describe("PriceField — input attributes (type='text', inputMode='decimal')", () => {
  it("renders as type='text' (not type='number')", () => {
    render(<PriceField label="Crown" value="100" onChange={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    expect(screen.getByRole("textbox")).toHaveAttribute("type", "text");
  });

  it("renders with inputMode='decimal' for mobile keyboard hint", () => {
    render(<PriceField label="Crown" value="100" onChange={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    expect(screen.getByRole("textbox")).toHaveAttribute("inputmode", "decimal");
  });

  it("renders with a decimal pattern for browser validation hint", () => {
    render(<PriceField label="Crown" value="100" onChange={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "pattern",
      "[0-9]*[.]?[0-9]*",
    );
  });
});
