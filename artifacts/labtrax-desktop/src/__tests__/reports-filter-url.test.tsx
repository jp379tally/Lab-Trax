/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Router, useSearch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { DateRangePicker, type DateRange } from "@/components/reports/DateRangePicker";
import { useReportFilters } from "@/components/reports/useReportFilters";

const RANGE: DateRange = {
  preset: "custom",
  from: new Date(2025, 0, 2).toISOString(),
  to: new Date(2025, 0, 15, 23, 59, 59, 999).toISOString(),
};
const FORECAST_LABS = [{ id: "admin-1" }, { id: "admin-2" }];

function Harness() {
  const filters = useReportFilters("lab-1", FORECAST_LABS);
  const search = useSearch();
  return (
    <>
      <output data-testid="url">{search}</output>
      <output data-testid="filters">{JSON.stringify(filters)}</output>
      <DateRangePicker value={filters.range} onChange={filters.setRange} />
      <button onClick={() => filters.setOrgId("lab-2")}>Lab 2</button>
      <button onClick={() => filters.setForecastOrgId("admin-2")}>Forecast lab 2</button>
      <button onClick={() => filters.setGroupBy("day")}>Daily sales</button>
      <button onClick={() => filters.setSummaryGroupBy("week")}>Weekly summary</button>
      <button onClick={() => filters.setStatsRange(RANGE)}>Stats dates</button>
      <button onClick={() => filters.setStatsGroupBy("year")}>Yearly stats</button>
      {(["summary", "production", "sales", "forecast", "pnl", "balance-sheet", "stats"] as const).map((tab) => (
        <button key={tab} onClick={() => filters.setTab(tab)}>{tab}</button>
      ))}
    </>
  );
}

function mount(path = "/reports", base = "") {
  const location = memoryLocation({ path, record: true });
  const view = render(<Router hook={location.hook} base={base}><Harness /></Router>);
  return { ...view, location };
}

function params() {
  return new URLSearchParams(screen.getByTestId("url").textContent ?? "");
}
function filters() {
  return JSON.parse(screen.getByTestId("filters").textContent!) as ReturnType<typeof useReportFilters>;
}

describe("Report filter URL persistence", () => {
  it("writes each tab and the selected lab without dropping unrelated parameters or the artifact base", () => {
    const { location } = mount("/desktop/reports?extra=kept", "/desktop");
    fireEvent.click(screen.getByText("Lab 2"));
    for (const tab of ["production", "sales", "forecast", "pnl", "balance-sheet", "stats", "summary"]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      expect(params().get("tab")).toBe(tab);
      expect(params().get("org")).toBe("lab-2");
      expect(params().get("extra")).toBe("kept");
    }
    expect(location.history).toHaveLength(1);
    expect(location.history![0]).toMatch(/^\/desktop\/reports\?/);
  });

  it("freezes preset dates, preserves manual grouping on reload, and follows preset grouping on changes", () => {
    const view = mount("/reports?tab=sales&preset=month&groupBy=day");
    const original = filters().range;
    expect(params().get("from")).toBe(original.from);
    expect(params().get("to")).toBe(original.to);
    expect(filters().groupBy).toBe("day");
    const link = view.location.history![0]!;
    view.unmount();
    mount(link);
    expect(filters().range).toEqual(original);
    expect(filters().groupBy).toBe("day");
    fireEvent.change(screen.getByTestId("date-range-preset"), { target: { value: "year" } });
    expect(params().get("preset")).toBe("year");
    expect(params().get("groupBy")).toBe("month");
    fireEvent.change(screen.getByTestId("date-range-preset"), { target: { value: "quarter" } });
    expect(params().get("groupBy")).toBe("week");
    fireEvent.click(screen.getByText("Daily sales"));
    fireEvent.change(screen.getByTestId("date-range-preset"), { target: { value: "custom" } });
    expect(params().get("groupBy")).toBe("day");
  });

  it("restores exact custom timestamps and independent Stats, Summary and Forecast selections from a shared URL", () => {
    const initial = new URLSearchParams({ tab: "sales", org: "lab-2", ...RANGE, groupBy: "week" });
    const view = mount(`/reports?${initial}`);
    fireEvent.click(screen.getByText("Weekly summary"));
    fireEvent.click(screen.getByText("Stats dates"));
    fireEvent.click(screen.getByText("Yearly stats"));
    fireEvent.click(screen.getByText("Forecast lab 2"));
    fireEvent.click(screen.getByRole("button", { name: "stats" }));
    const link = view.location.history![0]!;
    view.unmount();
    mount(link);
    expect(filters()).toMatchObject({
      tab: "stats", orgId: "lab-2", range: RANGE, groupBy: "week",
      statsRange: RANGE, statsGroupBy: "year", summaryGroupBy: "week", forecastOrgId: "admin-2",
    });
    fireEvent.change(screen.getByTestId("date-range-preset"), { target: { value: "today" } });
    expect(filters().statsRange).toEqual(RANGE);
    fireEvent.click(screen.getByRole("button", { name: "sales" }));
    expect(filters().statsGroupBy).toBe("year");
  });

  it("handles same-page navigation and back/forward query changes without stale state", () => {
    const { location } = mount();
    const destination = `/reports?${new URLSearchParams({ tab: "pnl", org: "lab-2", ...RANGE })}`;
    act(() => location.navigate(destination));
    expect(filters()).toMatchObject({ tab: "pnl", orgId: "lab-2", range: RANGE });
    act(() => location.navigate("/reports?tab=production&preset=year"));
    expect(filters().tab).toBe("production");
    expect(filters().range.preset).toBe("year");
    act(() => location.navigate(destination));
    expect(filters().range).toEqual(RANGE);
  });

  it.each([
    "tab=invalid&preset=invalid&from=bad&to=bad&groupBy=year&stats-groupBy=bad",
    "from=2025-02-01&to=2025-01-01",
  ])("uses safe defaults for malformed links: %s", (query) => {
    mount(`/reports?${query}`);
    expect(filters()).toMatchObject({ tab: "summary", range: { preset: "month" }, groupBy: "week", statsGroupBy: "month" });
    expect(Number.isFinite(Date.parse(params().get("from")!))).toBe(true);
    expect(Date.parse(params().get("to")!)).toBeGreaterThanOrEqual(Date.parse(params().get("from")!));
  });

  it("keeps Forecast selection inside its existing admin-lab eligibility and records the effective lab", () => {
    mount("/reports?tab=forecast&org=lab-2&forecast-org=lab-2");
    expect(filters().forecastOrgId).toBe("admin-1");
    expect(params().get("forecast-org")).toBe("admin-1");
    expect(params().get("org")).toBe("lab-2");
  });

  it("only writes valid applied custom dates and keeps date-picker drafts in sync with URL navigation", async () => {
    const { container, location } = mount(`/reports?${new URLSearchParams({ ...RANGE })}`);
    const inputs = container.querySelectorAll("input[type=date]");
    const before = filters().range;
    fireEvent.change(inputs[0]!, { target: { value: "2025-02-02" } });
    fireEvent.blur(inputs[0]!);
    expect(filters().range).toEqual(before);
    fireEvent.change(inputs[1]!, { target: { value: "2025-02-15" } });
    fireEvent.blur(inputs[1]!);
    expect(filters().range.preset).toBe("custom");
    expect(new Date(filters().range.from).getDate()).toBe(2);
    expect(new Date(filters().range.to).getDate()).toBe(15);
    act(() => location.navigate(`/reports?${new URLSearchParams({ ...RANGE })}`));
    await waitFor(() => expect((inputs[0] as HTMLInputElement).value).toBe("2025-01-02"));
    expect((inputs[1] as HTMLInputElement).value).toBe("2025-01-15");
  });
});
