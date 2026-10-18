import React, { useState } from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleErrorOutput } from "../../../vitest.setup";

afterEach(() => {
  vi.useRealTimers();
});

describe("React act warning gate", () => {
  it("forwards unrelated console errors to the underlying logger unchanged", () => {
    const outputSpy = vi.spyOn(consoleErrorOutput, "write");
    const error = new Error("details");
    const args = ["An unrelated console error", { code: "E_TEST" }, error] as const;

    expect(() => {
      console.error(...args);
    }).not.toThrow();

    expect(outputSpy).toHaveBeenCalledOnce();
    expect(outputSpy).toHaveBeenCalledWith(...args);
    outputSpy.mockRestore();
  });

  it("fails on escaped updates without hiding console output", () => {
    expect(() => {
      console.error(
        "An update to %s inside a test was not wrapped in act(...).",
        "EscapedUpdate",
      );
    }).toThrow("React state update was not wrapped in act(...)");
  });

  it("keeps promise-backed timer updates inside act", async () => {
    vi.useFakeTimers();

    function AsyncUpdateProbe() {
      const [status, setStatus] = useState("idle");

      function startAsyncUpdate() {
        void Promise.resolve().then(() => {
          setTimeout(() => setStatus("complete"), 25);
        });
      }

      return React.createElement(
        Pressable,
        { testID: "start-async-update", onPress: startAsyncUpdate },
        React.createElement(Text, null, status),
      );
    }

    const { getByTestId, getByText } = await render(
      React.createElement(AsyncUpdateProbe),
    );

    await act(async () => {
      await fireEvent.press(getByTestId("start-async-update"));
      await Promise.resolve();
      vi.advanceTimersByTime(25);
      await Promise.resolve();
    });

    expect(getByText("complete")).toBeTruthy();
  });
});
