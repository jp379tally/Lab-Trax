import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { defaultRange, rangeFromPreset, type DateRange, type DateRangePresetKey } from "./DateRangePicker";

export type SalesGrouping = "day" | "week" | "month";
export type StatsGrouping = SalesGrouping | "year";
const TAB_KEYS = ["summary", "production", "sales", "forecast", "pnl", "balance-sheet", "stats"] as const;
const PRESETS: DateRangePresetKey[] = ["today", "week", "month", "quarter", "year", "custom"];

interface ReportFilters {
  tab: typeof TAB_KEYS[number];
  orgId: string | null;
  range: DateRange;
  groupBy: SalesGrouping;
  summaryGroupBy: SalesGrouping;
  statsRange: DateRange;
  statsGroupBy: StatsGrouping;
  forecastOrgId: string | null;
}

function readRange(params: URLSearchParams, fallback: DateRange, prefix = ""): DateRange {
  const requested = params.get(`${prefix}preset`);
  const preset = PRESETS.includes(requested as DateRangePresetKey) ? requested as DateRangePresetKey : null;
  const from = params.get(`${prefix}from`);
  const to = params.get(`${prefix}to`);
  if (from && to && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) && Date.parse(to) >= Date.parse(from)) {
    return { preset: preset ?? "custom", from, to };
  }
  if (preset && preset !== "custom") {
    const dates = rangeFromPreset(preset);
    return { preset, from: dates.from.toISOString(), to: dates.to.toISOString() };
  }
  return fallback;
}

function salesGrouping(preset: DateRangePresetKey): SalesGrouping {
  if (preset === "today" || preset === "week") return "day";
  if (preset === "month" || preset === "quarter") return "week";
  return "month";
}

/**
 * The URL is the source of truth, including same-page and back/forward navigation.
 * Stats dates remain independent from financial dates. Defaults are frozen into
 * the link so a shared preset restores its original dates, not today's dates.
 */
export function useReportFilters(defaultOrg: string | null, forecastLabs: readonly { id: string }[]) {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const [fallbackRange] = useState(defaultRange);
  const filters = useMemo<ReportFilters>(() => {
    const params = new URLSearchParams(search);
    const requestedTab = params.get("tab");
    const range = readRange(params, fallbackRange);
    const group = params.get("groupBy");
    const summaryGroup = params.get("summary-groupBy");
    const statsGroup = params.get("stats-groupBy");
    const requestedForecastOrg = params.get("forecast-org");
    return {
      tab: TAB_KEYS.includes(requestedTab as typeof TAB_KEYS[number]) ? requestedTab as typeof TAB_KEYS[number] : "summary" as const,
      orgId: params.get("org") || defaultOrg,
      range,
      groupBy: (group === "day" || group === "week" || group === "month") ? group : salesGrouping(range.preset),
      summaryGroupBy: (summaryGroup === "day" || summaryGroup === "week" || summaryGroup === "month") ? summaryGroup : "month" as const,
      statsRange: readRange(params, fallbackRange, "stats-"),
      statsGroupBy: (statsGroup === "day" || statsGroup === "week" || statsGroup === "month" || statsGroup === "year") ? statsGroup : "month" as const,
      forecastOrgId: forecastLabs.length > 0
        ? (forecastLabs.some((lab) => lab.id === requestedForecastOrg) ? requestedForecastOrg : forecastLabs[0]!.id)
        : requestedForecastOrg,
    };
  }, [search, fallbackRange, defaultOrg, forecastLabs]);

  function urlFor(next: typeof filters) {
    const params = new URLSearchParams(search);
    params.set("tab", next.tab);
    if (next.orgId) params.set("org", next.orgId);
    else params.delete("org");
    params.set("preset", next.range.preset);
    params.set("from", next.range.from);
    params.set("to", next.range.to);
    params.set("groupBy", next.groupBy);
    params.set("summary-groupBy", next.summaryGroupBy);
    params.set("stats-preset", next.statsRange.preset);
    params.set("stats-from", next.statsRange.from);
    params.set("stats-to", next.statsRange.to);
    params.set("stats-groupBy", next.statsGroupBy);
    if (next.forecastOrgId) params.set("forecast-org", next.forecastOrgId);
    else params.delete("forecast-org");
    return `${path}?${params}`;
  }

  const canonicalUrl = urlFor(filters);
  useEffect(() => {
    if (canonicalUrl !== `${path}?${search}`) navigate(canonicalUrl, { replace: true });
  }, [canonicalUrl, path, search, navigate]);

  function update(patch: Partial<typeof filters>) {
    navigate(urlFor({ ...filters, ...patch }), { replace: true });
  }

  return {
    ...filters,
    setTab: (tab: typeof filters.tab) => update({ tab }),
    setOrgId: (orgId: string | null) => update({ orgId }),
    setRange: (range: DateRange) => update({
      range,
      groupBy: range.preset !== filters.range.preset && range.preset !== "custom"
        ? salesGrouping(range.preset) : filters.groupBy,
    }),
    setGroupBy: (groupBy: SalesGrouping) => update({ groupBy }),
    setSummaryGroupBy: (summaryGroupBy: SalesGrouping) => update({ summaryGroupBy }),
    setStatsRange: (statsRange: DateRange) => update({ statsRange }),
    setStatsGroupBy: (statsGroupBy: StatsGrouping) => update({ statsGroupBy }),
    setForecastOrgId: (forecastOrgId: string) => update({ forecastOrgId }),
  };
}
