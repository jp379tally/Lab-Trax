/** @vitest-environment jsdom */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { BulkPriceTools } from "@/pages/pricing";
import { makeAuthWrapper } from "../../__tests__/test-utils";

/**
 * Regression suite for the BulkPriceTools collapsible in the Pricing Tier
 * editor ("Bulk edit prices").
 *
 * Guards:
 * - Preview rows always display both the before and after price with
 *   exactly two decimal places (formatPriceTwoDecimals applied to both).
 * - Calculated results forwarded to onApply remain numerically unchanged —
 *   visual formatting does not alter the stored value.
 * - No preview is rendered when an error is returned (invalid percent, no
 *   priced items, invalid paste).
 * - Preview is cleared when the panel is collapsed.
 */

const KEYS = ["zirconia_crown", "pfm_crown", "implant"];
const BASE_PRICES: Record<string, string> = {
  zirconia_crown: "100",
  pfm_crown: "200",
  implant: "0",
};

function openBulkPanel() {
  fireEvent.click(screen.getByText(/Bulk edit prices/i));
}

describe("BulkPriceTools — percent adjust", () => {
  it("shows before/after rows with two decimal places after applying a percent", () => {
    const onApply = vi.fn();
    render(<BulkPriceTools keys={KEYS} prices={BASE_PRICES} onApply={onApply} />, {
      wrapper: makeAuthWrapper(),
    });
    openBulkPanel();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 5 or -3/i), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(screen.getByText("100.00")).toBeInTheDocument();
    expect(screen.getByText("110.00")).toBeInTheDocument();
    expect(screen.getByText("200.00")).toBeInTheDocument();
    expect(screen.getByText("220.00")).toBeInTheDocument();
  });

  it("pads whole-number before values to two decimals in preview", () => {
    const onApply = vi.fn();
    render(
      <BulkPriceTools
        keys={["zirconia_crown"]}
        prices={{ zirconia_crown: "99" }}
        onApply={onApply}
      />,
      { wrapper: makeAuthWrapper() },
    );
    openBulkPanel();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 5 or -3/i), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(screen.getByText("99.00")).toBeInTheDocument();
    expect(screen.getByText("103.95")).toBeInTheDocument();
  });

  it("does not show preview when no percent is entered", () => {
    const onApply = vi.fn();
    render(<BulkPriceTools keys={KEYS} prices={BASE_PRICES} onApply={onApply} />, {
      wrapper: makeAuthWrapper(),
    });
    openBulkPanel();

    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByText("110.00")).toBeNull();
    expect(screen.queryByText("100.00")).toBeNull();
  });

  it("does not show preview when no items have a positive price", () => {
    const onApply = vi.fn();
    render(
      <BulkPriceTools
        keys={["implant"]}
        prices={{ implant: "0" }}
        onApply={onApply}
      />,
      { wrapper: makeAuthWrapper() },
    );
    openBulkPanel();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 5 or -3/i), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: /Bulk price result/i })).toBeNull();
  });

  it("forwards calculated values to onApply unchanged", () => {
    const onApply = vi.fn();
    render(
      <BulkPriceTools
        keys={["zirconia_crown"]}
        prices={{ zirconia_crown: "100" }}
        onApply={onApply}
      />,
      { wrapper: makeAuthWrapper() },
    );
    openBulkPanel();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 5 or -3/i), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ zirconia_crown: "110.00" }),
    );
  });
});

describe("BulkPriceTools — paste", () => {
  it("shows before/after rows with two decimal places after applying pasted prices", () => {
    const onApply = vi.fn();
    render(<BulkPriceTools keys={KEYS} prices={BASE_PRICES} onApply={onApply} />, {
      wrapper: makeAuthWrapper(),
    });
    openBulkPanel();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "zirconia_crown = 150\npfm_crown = 250" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Apply pasted prices/i }));

    expect(screen.getByText("150.00")).toBeInTheDocument();
    expect(screen.getByText("250.00")).toBeInTheDocument();
    expect(screen.getByText("100.00")).toBeInTheDocument();
    expect(screen.getByText("200.00")).toBeInTheDocument();
  });

  it("pads whole-number pasted values to two decimals in preview", () => {
    const onApply = vi.fn();
    render(
      <BulkPriceTools
        keys={["zirconia_crown"]}
        prices={{ zirconia_crown: "" }}
        onApply={onApply}
      />,
      { wrapper: makeAuthWrapper() },
    );
    openBulkPanel();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "zirconia_crown = 300" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Apply pasted prices/i }));

    expect(screen.getByText("300.00")).toBeInTheDocument();
  });

  it("does not show preview when paste is empty", () => {
    const onApply = vi.fn();
    render(<BulkPriceTools keys={KEYS} prices={BASE_PRICES} onApply={onApply} />, {
      wrapper: makeAuthWrapper(),
    });
    openBulkPanel();

    fireEvent.click(screen.getByRole("button", { name: /Apply pasted prices/i }));

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: /Bulk price result/i })).toBeNull();
  });

  it("forwards pasted calculated values to onApply unchanged", () => {
    const onApply = vi.fn();
    render(
      <BulkPriceTools
        keys={["zirconia_crown"]}
        prices={{ zirconia_crown: "100" }}
        onApply={onApply}
      />,
      { wrapper: makeAuthWrapper() },
    );
    openBulkPanel();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "zirconia_crown = 150" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Apply pasted prices/i }));

    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ zirconia_crown: "150.00" }),
    );
  });
});

describe("BulkPriceTools — preview lifecycle", () => {
  it("clears the preview when the panel is collapsed and re-expanded", () => {
    const onApply = vi.fn();
    render(<BulkPriceTools keys={KEYS} prices={BASE_PRICES} onApply={onApply} />, {
      wrapper: makeAuthWrapper(),
    });
    openBulkPanel();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 5 or -3/i), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(screen.getByText("110.00")).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Bulk edit prices/i));
    expect(screen.queryByText("110.00")).toBeNull();
  });
});
