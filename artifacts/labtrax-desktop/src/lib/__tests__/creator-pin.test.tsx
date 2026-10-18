/** @vitest-environment jsdom */
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { PinField } from "@/lib/creator";

afterEach(cleanup);
describe("PinField", () => {
  it("verifies exactly once when the 7th digit arrives", () => {
    const done = vi.fn();
    render(<PinField onComplete={done} />);
    const input = screen.getByTestId("input-creator-pin");
    fireEvent.change(input, { target: { value: "123456" } });
    expect(done).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "1234567" } });
    fireEvent.change(input, { target: { value: "1234567" } });
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("1234567");
  });
  it("handles pasted PIN with non-digits", () => {
    const done = vi.fn();
    render(<PinField onComplete={done} />);
    fireEvent.change(screen.getByTestId("input-creator-pin"), { target: { value: "12-34 567" } });
    expect(done).toHaveBeenCalledWith("1234567");
  });
});
