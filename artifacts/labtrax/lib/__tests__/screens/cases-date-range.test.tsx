import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, act, waitFor, within } from "@testing-library/react-native";
import { resetMockAppState, setMockAppState, lastUseCasesParams } from "../../../vitest.setup";
import CasesListScreen from "@/app/(tabs)/index";
import { inProgressCase } from "./__fixtures__/cases";

beforeEach(() => setMockAppState({ cases: [inProgressCase] }));
afterEach(() => { resetMockAppState(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("Cases native date controls", () => {
  it("keeps compact summary tiles with Date, Created context, Date due and Location", async () => {
    const screen = await render(<CasesListScreen />);
    await act(async () => undefined);
    expect(screen.getByTestId("cases-summary")).toBeTruthy();
    expect(screen.getByTestId("cases-summary-total-value").props.children).toBe("0");
    expect(screen.getByTestId("cases-summary-overdue-value")).toBeTruthy();
    expect(screen.getByText("Date")).toBeTruthy();
    expect(screen.getAllByText("Date due").length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByTestId("cases-date-filter-chip"));
    expect(screen.getByText("Date created")).toBeTruthy();
    expect(within(screen.getByTestId("cases-status-filter-chip")).getByText("Location")).toBeTruthy();
    expect(screen.getByText("Filter by location")).toBeTruthy();
  });
  it.each(["created", "due"] as const)("applies and reopens a %s range without changing the other date filter", async target => {
    setMockAppState({
      casesByPage: {
        1: [inProgressCase],
        2: [{ ...inProgressCase, id: "page-two", caseNumber: "PAGE-2" }],
      },
      casesTotal: 2,
      casesHasMore: true,
    });
    const screen = await render(<CasesListScreen />);
    await act(async () => undefined);
    await fireEvent.press(screen.getByTestId("cases-load-more"));
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({ page: 2 }));
    const chip = screen.getByTestId(target === "created" ? "cases-date-filter-chip" : "cases-due-date-filter-chip");
    await fireEvent.press(chip);
    // Picker sheets remain mounted under the test Modal stub.
    await fireEvent.press(screen.getByText("Custom range"));
    await fireEvent.changeText(screen.getByTestId("case-range-start"), "5/5/2025");
    await fireEvent.changeText(screen.getByTestId("case-range-end"), "5/10/2025");
    await fireEvent.press(within(screen.getByTestId("cases-custom-range-panel")).getByText("Apply"));
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({
      [target === "created" ? "createdStart" : "dueStart"]: "2025-05-05",
      [target === "created" ? "createdEnd" : "dueEnd"]: "2025-05-10",
      page: 1,
    }));
    expect(lastUseCasesParams()).not.toHaveProperty(target === "created" ? "dueStart" : "createdStart");
    await fireEvent.press(chip);
    await fireEvent.press(screen.getByText("Custom range"));
    expect(screen.getByTestId("case-range-end").props.value).toBe("05/10/2025");
    await fireEvent.changeText(screen.getByTestId("case-range-end"), "5/15/2025");
    await fireEvent.press(within(screen.getByTestId("cases-custom-range-panel")).getByText("Cancel"));
    expect(lastUseCasesParams()).toMatchObject({ [target === "created" ? "createdEnd" : "dueEnd"]: "2025-05-10" });
  });
  it.each([[2026, 0, 1], [2026, 2, 9], [2026, 10, 2]])("Yesterday uses the previous local calendar day across year/DST boundaries (%s/%s/%s)", async (year, month, day) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(year, month, day, 12));
    const screen = await render(<CasesListScreen />);
    await act(async () => undefined);
    await fireEvent.press(screen.getByText("Date"));
    await fireEvent.press(screen.getByText("Yesterday"));
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({ createdStart: expected, createdEnd: expected, page: 1 }));
  });
});
