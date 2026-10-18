import React from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import * as Native from "react-native";
import * as SafeArea from "react-native-safe-area-context";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import { CaseRangeWindow } from "@/components/CaseRangeWindow";

// The global controller passthrough drops layout props. Preserve them here
// so these assertions check the actual modal's keyboard viewport contract.
vi.mock("react-native-keyboard-controller", async () => {
  const React = await import("react");
  const Native = await import("react-native");
  return { KeyboardAvoidingView: (props: React.ComponentProps<typeof Native.KeyboardAvoidingView>) => React.createElement(Native.KeyboardAvoidingView, props) };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("native Cases range window", () => {
  it.each(["ios", "android"])("constrains its scrollable %s layout to safe areas and accommodates the keyboard", async os => {
    vi.spyOn(Native, "useWindowDimensions").mockReturnValue({ width: 320, height: 568, scale: 2, fontScale: 1 });
    vi.spyOn(SafeArea, "useSafeAreaInsets").mockReturnValue({ top: 44, bottom: 34, left: 0, right: 0 });
    const platform = Native.Platform as { OS: string };
    const originalOS = platform.OS;
    platform.OS = os;
    try {
      const screen = await render(<CaseRangeWindow start="" end="" context="due" onApply={() => {}} onCancel={() => {}} />);
      const panel = screen.getByTestId("cases-custom-range-panel");
      expect(panel.props.style).toMatchObject({ width: 296, maxHeight: 466, flexShrink: 1 });
      const viewport = screen.getByTestId("case-range-keyboard-viewport");
      expect(viewport.props.behavior).toBe(os === "ios" ? "padding" : "height");
      expect(viewport.props.style).toMatchObject({ flex: 1, paddingTop: 56, paddingBottom: 46 });
      expect(panel.props.accessibilityViewIsModal).toBe(true);
    } finally { platform.OS = originalOS; }
  });
  it("normalizes Next, Tab and Done using the current year without committing drafts", async () => {
    const apply = vi.fn();
    const screen = await render(<CaseRangeWindow start="" end="" context="created" onApply={apply} onCancel={() => {}} />);
    const year = new Date().getFullYear();
    await fireEvent.changeText(screen.getByTestId("case-range-start"), "5/5");
    await fireEvent(screen.getByTestId("case-range-start"), "submitEditing");
    expect(screen.getByTestId("case-range-start").props.value).toBe(`05/05/${year}`);
    await fireEvent.changeText(screen.getByTestId("case-range-end"), "5/10");
    await fireEvent(screen.getByTestId("case-range-end"), "keyPress", { nativeEvent: { key: "Tab" } });
    expect(screen.getByTestId("case-range-end").props.value).toBe(`05/10/${year}`);
    await fireEvent(screen.getByTestId("case-range-end"), "submitEditing");
    expect(apply).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText("Apply"));
    expect(apply).toHaveBeenCalledWith(`${year}-05-05`, `${year}-05-10`);
  });
  it("rejects invalid days and reversed calendar endpoints but allows a same-day range", async () => {
    const apply = vi.fn();
    const screen = await render(<CaseRangeWindow start="2025-05-05" end="2025-05-10" context="due" onApply={apply} onCancel={() => {}} />);
    await fireEvent.press(screen.getByLabelText("05/10/2025"));
    await fireEvent.press(screen.getByLabelText("05/05/2025"));
    expect(screen.getByText("End date must be on or after Start date.")).toBeTruthy();
    await fireEvent.press(screen.getByText("Apply"));
    expect(apply).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId("case-range-end"), "2/30/2025");
    await fireEvent(screen.getByTestId("case-range-end"), "blur");
    expect(screen.getByText(/Enter a real/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Next month"));
    expect(screen.getByText("June 2025")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("06/05/2025"));
    await fireEvent.press(screen.getByLabelText("06/05/2025"));
    expect(screen.getByTestId("case-range-start").props.value).toBe("06/05/2025");
    expect(screen.getByTestId("case-range-end").props.value).toBe("06/05/2025");
    await fireEvent.press(screen.getByText("Apply"));
    expect(apply).toHaveBeenCalledWith("2025-06-05", "2025-06-05");
  });
  it("cancels on native Back and backdrop without applying, and initializes from applied values", async () => {
    const apply = vi.fn(), cancel = vi.fn();
    const screen = await render(<CaseRangeWindow start="2025-05-05" end="2025-05-10" context="created" onApply={apply} onCancel={cancel} />);
    await fireEvent.changeText(screen.getByTestId("case-range-start"), "7/7");
    await fireEvent(screen.getByTestId("case-range-modal"), "requestClose");
    expect(cancel).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText("Cancel date range", { includeHiddenElements: true }));
    expect(cancel).toHaveBeenCalledTimes(2);
    await fireEvent(screen.getByTestId("case-range-end"), "keyPress", { nativeEvent: { key: "Escape" } });
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(apply).not.toHaveBeenCalled();
    await screen.unmount();
    const reopened = await render(<CaseRangeWindow start="2025-05-05" end="2025-05-10" context="created" onApply={apply} onCancel={cancel} />);
    expect(reopened.getByTestId("case-range-start").props.value).toBe("05/05/2025");
  });
});
