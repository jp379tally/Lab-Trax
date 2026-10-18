import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react-native";
import { PinInput } from "../../components/creator/CreatorGate";

describe("Creator native PIN completion", () => {
  afterEach(cleanup);
  it("verifies completed typed entry once without a submit action", async () => {
    const verify = vi.fn();
    const screen = await render(<PinInput onComplete={verify} />);
    const input = screen.getByTestId("creator-pin-input");
    await fireEvent.changeText(input, "123456");
    expect(verify).not.toHaveBeenCalled();
    await fireEvent.changeText(input, "1234567");
    await fireEvent.changeText(input, "1234567");
    expect(verify).toHaveBeenCalledExactlyOnceWith("1234567");
  });

  it("verifies pasted digits once and never loops on a displayed rejection", async () => {
    const verify = vi.fn();
    const screen = await render(<PinInput onComplete={verify} error="Incorrect Creator PIN." />);
    const input = screen.getByTestId("creator-pin-input");
    await fireEvent.changeText(input, "12 34567");
    await fireEvent.changeText(input, "1234567");
    expect(verify).toHaveBeenCalledExactlyOnceWith("1234567");
    expect(screen.getByTestId("creator-pin-error")).toBeTruthy();
  });

  it("ignores even synthetic input changes while a request is pending", async () => {
    const verify = vi.fn();
    const screen = await render(<PinInput onComplete={verify} busy />);
    await fireEvent.changeText(screen.getByTestId("creator-pin-input"), "1234567");
    expect(verify).not.toHaveBeenCalled();
  });
});
