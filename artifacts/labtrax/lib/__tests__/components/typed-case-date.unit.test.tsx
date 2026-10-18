import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import { DateField } from "@/components/DateField";
import { parseTypedCaseDate } from "@/lib/typed-case-date";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("typed case dates", () => {
  it("accepts exact real dates, including leap days and a different year", () => {
    expect(parseTypedCaseDate("02/29/2028")).toBe("2028-02-29");
    expect(parseTypedCaseDate("12/31/2037")).toBe("2037-12-31");
    for (const bad of ["02/29/2027", "02/30/2028", "13/01/2028", "00/12/2028", "04/31/2028", "2/01/2028", "02/01/28", "02/01/0000", ""]) {
      expect(parseTypedCaseDate(bad)).toBeNull();
    }
  });

  it("leaves the committed date alone for invalid input, cancel, and a fresh draft", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <DateField value="2026-03-10" onChange={onChange} allowTyping testID="due" />,
    );
    await fireEvent.press(screen.getByTestId("due"));
    await fireEvent.press(screen.getByTestId("due-type"));
    await fireEvent.changeText(screen.getByTestId("due-typed-input"), "");
    await fireEvent.press(screen.getByTestId("due-typed-confirm"));
    expect(screen.getByTestId("due-typed-error")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId("due-typed-input"), "02/30/2028");
    await fireEvent.press(screen.getByTestId("due-typed-confirm"));
    expect(screen.getByTestId("due-typed-error").props.children).toContain("real date");
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("due-typed-cancel"));
    await fireEvent.press(screen.getByTestId("due"));
    await fireEvent.press(screen.getByTestId("due-type"));
    expect(screen.getByTestId("due-typed-input").props.value).toBe("03/10/2026");
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId("due-typed-input"), "02/29/2028");
    await fireEvent.press(screen.getByTestId("due-typed-confirm"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("2028-02-29");
  });

  it("enforces inclusive calendar bounds for typed input and keeps calendar navigation", async () => {
    function Host() {
      const [value, setValue] = useState<string | null>(null);
      return <DateField value={value} onChange={setValue} allowTyping minDate="2028-02-28" maxDate="2028-02-29" testID="bounded" />;
    }
    const screen = await render(<Host />);
    await fireEvent.press(screen.getByTestId("bounded"));
    await fireEvent.press(screen.getByTestId("bounded-next"));
    await fireEvent.press(screen.getByTestId("bounded-type"));
    await fireEvent.changeText(screen.getByTestId("bounded-typed-input"), "02/27/2028");
    await fireEvent.press(screen.getByTestId("bounded-typed-confirm"));
    expect(screen.getByTestId("bounded-typed-error")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("bounded-typed-input"), "02/29/2028");
    await fireEvent.press(screen.getByTestId("bounded-typed-confirm"));
    expect(screen.getByTestId("bounded").props.children[0].props.children).toBe("02/29/2028");
  });
});