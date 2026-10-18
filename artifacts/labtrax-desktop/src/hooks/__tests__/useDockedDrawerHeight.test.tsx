/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDockedDrawerHeight } from "../useDockedDrawerHeight";

function Panel({ docked = true }: { docked?: boolean }) {
  const ref = useDockedDrawerHeight(docked);
  return <div ref={ref} data-testid="panel" />;
}

afterEach(() => vi.restoreAllMocks());

describe("docked drawer available height", () => {
  it("fits below page headings and follows shell scrolling and window resizing", () => {
    let top = 335;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top } as DOMRect),
    );
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
    const view = render(<Panel />);
    const panel = screen.getByTestId("panel");
    expect(panel.style.getPropertyValue("--case-drawer-height")).toBe("549px");
    top = 16;
    fireEvent.scroll(window);
    expect(panel.style.getPropertyValue("--case-drawer-height")).toBe("868px");
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(720);
    fireEvent.resize(window);
    expect(panel.style.getPropertyValue("--case-drawer-height")).toBe("688px");
    view.rerender(<Panel docked={false} />);
    expect(panel.style.getPropertyValue("--case-drawer-height")).toBe("");
  });

  it("does not constrain the full-height overlay drawer", () => {
    render(<Panel docked={false} />);
    expect(screen.getByTestId("panel").style.getPropertyValue("--case-drawer-height")).toBe("");
  });
});
