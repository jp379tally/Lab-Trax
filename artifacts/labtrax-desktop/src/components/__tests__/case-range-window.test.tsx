/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CaseRangeWindow } from "@/components/CaseRangeWindow";

describe("Case range window", () => {
  it("supports month navigation, sequential same-day selection, and inclusive highlighting", () => {
    const apply = vi.fn();
    render(<CaseRangeWindow start="2025-05-05" end="2025-05-10" onApply={apply} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "05/05/2025" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "05/10/2025" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("June 2025")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "05/12/2025" }));
    expect(screen.getByLabelText("End date")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "05/12/2025" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(apply).toHaveBeenCalledWith("2025-05-12", "2025-05-12");
  });
  it("rejects rollover and earlier calendar endpoints and synchronizes typed input", () => {
    render(<CaseRangeWindow start="2025-05-05" end="2025-05-10" onApply={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "05/10/2025" }));
    fireEvent.click(screen.getByRole("button", { name: "05/05/2025" }));
    expect(screen.getByRole("alert")).toHaveTextContent("on or after");
    const end = screen.getByLabelText("End date");
    fireEvent.change(end, { target: { value: "2/30/2025" } });
    fireEvent.blur(end);
    expect(screen.getByRole("alert")).toHaveTextContent("real");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.change(end, { target: { value: "5/15/2025" } });
    fireEvent.blur(end);
    expect(end).toHaveValue("05/15/2025");
    expect(screen.getByRole("button", { name: "05/15/2025" })).toHaveAttribute("aria-pressed", "true");
  });
});
