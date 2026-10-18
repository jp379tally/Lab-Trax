import { describe, expect, it } from "vitest";
import {
  invoiceStatusSelectionFromLegacy,
  invoiceStatusSelectionToLegacy,
  invoiceStatusSelectionValues,
  normalizeInvoiceFilterPrecedence,
  transitionInvoiceStatusSelection,
  transitionInvoiceStatusSelectionValues,
  millisecondsUntilNextLocalMidnight,
  dateRangeForFilter,
  matchesStatusFilters,
  type InvoiceStatusSelection,
  type InvoiceUnifiedStatusFilter,
} from "./invoice-filters";

describe("invoice local-midnight refresh timing", () => {
  it.each([
    [new Date(2026, 1, 28, 23, 59), new Date(2026, 2, 1, 0, 0)],
    [new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1, 0, 0)],
  ])("schedules the next refresh at local midnight (%s)", (now, midnight) => {
    expect(millisecondsUntilNextLocalMidnight(now)).toBe(
      midnight.getTime() - now.getTime(),
    );
  });

  it.each([
    ["spring-forward", 2026, 2, 8, 23, "2026-03-08", "2026-03-07"],
    ["fall-back", 2026, 10, 1, 25, "2026-11-01", "2026-10-31"],
  ] as const)(
    "uses the correct local day length and invoice dates on %s in Los Angeles",
    (_transition, year, month, day, hours, todayKey, yesterdayKey) => {
      const previousTimezone = process.env.TZ;
      try {
        process.env.TZ = "America/Los_Angeles";
        const midnight = new Date(year, month, day);
        const nextMidnight = new Date(year, month, day + 1);
        expect(nextMidnight.getTime() - midnight.getTime()).toBe(hours * 60 * 60 * 1000);
        expect(millisecondsUntilNextLocalMidnight(midnight)).toBe(hours * 60 * 60 * 1000);

        const now = new Date(year, month, day, 12);
        const today = dateRangeForFilter("today", now)!;
        const yesterday = dateRangeForFilter("yesterday", now)!;
        expect(today.start.toISOString().slice(0, 10)).toBe(todayKey);
        expect(today.end.toISOString().slice(0, 10)).toBe(
          new Date(year, month, day + 1).toISOString().slice(0, 10),
        );
        expect(yesterday.start.toISOString().slice(0, 10)).toBe(yesterdayKey);
        expect(yesterday.end).toEqual(today.start);
      } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
      }
    },
  );
});

describe("invoice status selection", () => {
  it("treats held recovery records as Draft without changing their persisted status", () => {
    expect(matchesStatusFilters({ status: "recovery_draft" }, ["draft"])).toBe(true);
    expect(matchesStatusFilters({ status: "draft" }, ["draft"])).toBe(true);
    expect(matchesStatusFilters({ status: "open" }, ["draft"])).toBe(false);
  });
  const all: InvoiceStatusSelection = { kind: "all" };

  it.each([
    ["all", { kind: "all" }],
    ["open", { kind: "view", view: "open" }],
    ["outstanding", { kind: "view", view: "outstanding" }],
    ["paid", { kind: "statuses", statuses: ["paid"] }],
    ["void", { kind: "statuses", statuses: ["void"] }],
    ["frozen", { kind: "statuses", statuses: ["frozen"] }],
    ["zero_balance", { kind: "statuses", statuses: ["zero_balance"] }],
  ] satisfies [InvoiceUnifiedStatusFilter, InvoiceStatusSelection][])(
    "transitions from All to %s",
    (choice, expected) => {
      expect(transitionInvoiceStatusSelection(all, choice)).toEqual(expected);
    },
  );

  it("replaces ordinary unions with Open and Outstanding", () => {
    const statuses: InvoiceStatusSelection = { kind: "statuses", statuses: ["paid", "void"] };
    expect(transitionInvoiceStatusSelection(statuses, "open")).toEqual({ kind: "view", view: "open" });
    expect(transitionInvoiceStatusSelection(statuses, "outstanding"))
      .toEqual({ kind: "view", view: "outstanding" });
  });

  it("replaces views with an ordinary status union", () => {
    expect(transitionInvoiceStatusSelection({ kind: "view", view: "open" }, "paid"))
      .toEqual({ kind: "statuses", statuses: ["paid"] });
    expect(transitionInvoiceStatusSelection({ kind: "view", view: "outstanding" }, "void"))
      .toEqual({ kind: "statuses", statuses: ["void"] });
  });

  it("adds and removes ordinary statuses, returning to All after the last removal", () => {
    const paid = transitionInvoiceStatusSelection(all, "paid");
    const union = transitionInvoiceStatusSelection(paid, "void");
    expect(union).toEqual({ kind: "statuses", statuses: ["paid", "void"] });
    expect(transitionInvoiceStatusSelection(union, "paid"))
      .toEqual({ kind: "statuses", statuses: ["void"] });
    expect(transitionInvoiceStatusSelection({ kind: "statuses", statuses: ["void"] }, "void"))
      .toEqual(all);
  });

  it("normalizes conflicting legacy fields with view precedence and drops invalid statuses", () => {
    expect(invoiceStatusSelectionFromLegacy("open", ["paid", "void"]))
      .toEqual({ kind: "view", view: "open" });
    expect(invoiceStatusSelectionFromLegacy("outstanding", ["zero_balance"]))
      .toEqual({ kind: "view", view: "outstanding" });
    expect(invoiceStatusSelectionFromLegacy("all", ["paid", "unknown", "void", "paid"]))
      .toEqual({ kind: "statuses", statuses: ["paid", "void"] });
    expect(invoiceStatusSelectionFromLegacy("all", ["open", "unknown"]))
      .toEqual({ kind: "view", view: "open" });
    expect(invoiceStatusSelectionFromLegacy("all", ["paid", "open", "void"]))
      .toEqual({ kind: "view", view: "open" });
  });

  it("adapts complete multi-select arrays without losing statuses that remain checked", () => {
    const union: InvoiceStatusSelection = { kind: "statuses", statuses: ["paid", "void"] };
    expect(transitionInvoiceStatusSelectionValues(union, ["void"]))
      .toEqual({ kind: "statuses", statuses: ["void"] });
    expect(transitionInvoiceStatusSelectionValues(union, []))
      .toEqual(all);
    expect(transitionInvoiceStatusSelectionValues(union, ["paid", "void", "open"]))
      .toEqual({ kind: "view", view: "open" });
    expect(transitionInvoiceStatusSelectionValues({ kind: "view", view: "open" }, ["open", "paid"]))
      .toEqual({ kind: "statuses", statuses: ["paid"] });
  });

  it("preserves the legacy view/status request contract", () => {
    expect(invoiceStatusSelectionToLegacy(all)).toEqual({ view: "all", statuses: [] });
    expect(invoiceStatusSelectionToLegacy({ kind: "view", view: "outstanding" }))
      .toEqual({ view: "outstanding", statuses: [] });
    expect(invoiceStatusSelectionToLegacy({ kind: "statuses", statuses: ["paid", "void"] }))
      .toEqual({ view: "all", statuses: ["paid", "void"] });
    expect(invoiceStatusSelectionValues(all)).toEqual(["all"]);
  });

  it("normalizes raw filter inputs with shared status and aging precedence", () => {
    expect(normalizeInvoiceFilterPrecedence({
      view: "open",
      statuses: "paid,zero_balance",
      legacyStatus: "void",
      aging: "custom",
    })).toMatchObject({
      view: "open",
      statuses: [],
      legacyStatus: null,
      aging: "custom",
    });
    expect(normalizeInvoiceFilterPrecedence({
      statuses: ["paid", "zero_balance"],
      legacyStatus: "void",
      aging: "0_30",
    })).toMatchObject({
      view: "all",
      statuses: ["paid", "zero_balance"],
      legacyStatus: null,
      aging: "0_30",
    });
    expect(normalizeInvoiceFilterPrecedence({
      legacyStatus: "open",
      aging: "90_plus",
    })).toMatchObject({
      view: "open",
      statuses: [],
      legacyStatus: "open",
      aging: "90_plus",
    });
    expect(normalizeInvoiceFilterPrecedence({
      view: "outstanding",
      statuses: ["paid"],
      legacyStatus: "void",
      aging: "custom",
    })).toMatchObject({
      view: "outstanding",
      statuses: [],
      legacyStatus: null,
      aging: null,
    });
  });
});