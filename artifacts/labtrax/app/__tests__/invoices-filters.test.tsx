import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react-native";
import { router } from "expo-router";
import { AppState } from "react-native";
import InvoicesScreen, {
  resetInvoiceRegisterSnapshotsForTests,
  seedInvoiceRegisterFiltersForTests,
} from "@/app/finance/invoices";
import {
  mockPagedInvoiceParams,
  resetMockAppState,
  setMockAppState,
} from "../../vitest.setup";
import {
  useInvoiceFilterFacets,
  usePagedInvoices,
} from "@workspace/api-client-react";

const yesterday = new Date(Date.now() - 86_400_000).toISOString();
const tomorrow = new Date(Date.now() + 86_400_000).toISOString();

function seed(admin = true) {
  setMockAppState({
    invoices: [
      { id: "open", invoiceNumber: "INV-OPEN", status: "open", total: 100, balanceDue: 100, issuedAt: new Date().toISOString(), dueAt: yesterday, labOrganizationId: "lab-1", providerOrganizationId: "p2", providerOrganization: { name: "Zenith" }, displayMetadataJson: { patientName: "Amy", billTo: "Dr Z" }, aiGenerated: true },
      { id: "partial", invoiceNumber: "INV-PARTIAL", status: "partially_paid", total: 200, balanceDue: 50, issuedAt: yesterday, dueAt: tomorrow, labOrganizationId: "lab-1", providerOrganizationId: "p1", providerOrganization: { name: "Acme" }, displayMetadataJson: { patientName: "Ben", billTo: "Dr A" } },
      { id: "paid", invoiceNumber: "INV-PAID", status: "paid", total: 300, balanceDue: 0, issuedAt: yesterday, dueAt: yesterday, labOrganizationId: "lab-1", providerOrganizationId: "p1", providerOrganization: { name: "Acme" } },
      { id: "void", invoiceNumber: "INV-VOID", status: "void", total: 50, balanceDue: 0, issuedAt: yesterday, dueAt: yesterday, labOrganizationId: "lab-1", frozen: true },
    ],
    meMemberships: admin ? [{ organizationId: "lab-1", role: "admin", status: "active", organization: { type: "lab" } }] : [],
  });
}

const ids = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.queryAllByTestId(/^invoice-(open|partial|paid|void)$/).map((node) => node.props.testID);

afterEach(() => { cleanup(); resetMockAppState(); resetInvoiceRegisterSnapshotsForTests(); vi.clearAllMocks(); });

describe("mobile invoice filter controls", () => {
  it("debounces typing, keeps the current register mounted, and clears immediately", async () => {
    seed();
    vi.useFakeTimers();
    try {
      const screen = await render(<InvoicesScreen />);

      await fireEvent.changeText(screen.getByTestId("invoice-search"), "I");
      await fireEvent.changeText(screen.getByTestId("invoice-search"), "IN");
      await fireEvent.changeText(screen.getByTestId("invoice-search"), "INV-PAID");

      expect(screen.getByTestId("invoice-search").props.value).toBe("INV-PAID");
      expect(screen.getByTestId("invoice-open")).toBeTruthy();
      expect(mockPagedInvoiceParams.calls.at(-1)).not.toHaveProperty("search");

      await act(() => vi.advanceTimersByTime(299));
      expect(mockPagedInvoiceParams.calls.at(-1)).not.toHaveProperty("search");

      await act(() => vi.advanceTimersByTime(1));
      expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({ search: "INV-PAID" });
      expect(screen.getByTestId("invoice-paid")).toBeTruthy();
      expect(screen.queryByTestId("invoice-open")).toBeNull();

      await fireEvent.press(screen.getByTestId("search-clear"));
      expect(mockPagedInvoiceParams.calls.at(-1)).not.toHaveProperty("search");
      expect(screen.getByTestId("invoice-open")).toBeTruthy();
      expect(screen.getByTestId("invoice-search").props.value).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("exercises the authenticated invoice route with lab-scoped API fixtures", async () => {
    seed();
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("view-open")).toBeNull();
    await fireEvent.press(screen.getByTestId("filters-open"));
    await fireEvent.press(screen.getByTestId("status-option-open"));
    await fireEvent.press(screen.getByTestId("invoice-filters-save"));
    expect(screen.queryByTestId("quick-frozen")).toBeNull();
    expect(screen.getByTestId("quick-zero-balance")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("filters-open"));
    expect(screen.getByTestId("status-option-paid")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("invoice-filters-cancel"));
    await fireEvent.press(screen.getByTestId("filters-open"));
    await fireEvent.press(screen.getByTestId("status-option-outstanding"));
    await fireEvent.press(screen.getByTestId("invoice-filters-save"));
    expect(screen.queryByTestId("quick-frozen")).toBeNull();
    expect(screen.queryByTestId("quick-zero-balance")).toBeNull();
    await fireEvent.press(screen.getByTestId("filters-open"));
    expect(screen.queryByTestId("overdue-option-0_30")).toBeNull();
    await fireEvent.press(screen.getByTestId("status-option-all"));
    await fireEvent.press(screen.getByTestId("invoice-filters-save"));
    expect(ids(screen)).toHaveLength(4);
  });

  it("combines ordinary statuses and replaces them with Outstanding", async () => {
    seed();
    const screen = await render(<InvoicesScreen />);
    await fireEvent.press(screen.getByTestId("filters-open"));
    await fireEvent.press(screen.getByTestId("status-option-paid"));
    await fireEvent.press(screen.getByTestId("status-option-void"));
    await fireEvent.press(screen.getByTestId("invoice-filters-save"));

    expect(ids(screen)).toEqual(["invoice-paid", "invoice-void"]);
    expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({ status: "paid,void" });

    await fireEvent.press(screen.getByTestId("filters-open"));
    await fireEvent.press(screen.getByTestId("status-option-outstanding"));
    expect(screen.queryByTestId("overdue-option-0_30")).toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-filters-save"));

    expect(ids(screen)).toEqual(["invoice-open"]);
    expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({ status: "open", view: "outstanding" });
  });

  // Regression guard for the shared mobile harness: the paged-invoices mock
  // has twice been edited into reading `params.search` unconditionally, which
  // throws for every caller that omits the params object or the search term
  // and takes the whole invoice/statement/finance suite down with it.
  it("serves harness invoices when called with no params and with params that carry no search term", async () => {
    seed();
    const withoutParams = await renderHook(() => usePagedInvoices());
    const withStatus = await renderHook(() => usePagedInvoices({ status: "open" }));
    expect(withoutParams.result.current.data).toHaveLength(4);
    expect(withStatus.result.current.data).toEqual([
      expect.objectContaining({ id: "open" }),
      expect.objectContaining({ id: "partial" }),
    ]);
  });

  it("derives invoice facets from invoice fixtures instead of the doctor directory", async () => {
    seed();
    setMockAppState({
      doctorDirectory: [
        {
          providerOrganizationId: "wrong-practice",
          practiceName: "Wrong Practice",
          doctorName: "Wrong Doctor",
        },
      ],
    });

    expect(useInvoiceFilterFacets().data).toEqual({
      practices: [
        { id: "p2", name: "Zenith" },
        { id: "p1", name: "Acme" },
      ],
      doctors: ["Dr Z", "Dr A"],
    });
  });

  it("requires both custom issued dates before applying", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 20, 10));
      seed();
      const screen = await render(<InvoicesScreen />);
      await fireEvent.press(screen.getByTestId("filters-open"));
      await fireEvent.press(screen.getByTestId("date-option-custom"));
      await fireEvent.press(screen.getByTestId("issued-date-start"));
      await fireEvent.press(screen.getByTestId("issued-date-start-day-20"));

      expect(screen.getByTestId("invoice-filters-save").props.disabled).toBe(true);
      await fireEvent.press(screen.getByTestId("invoice-filters-save"));
      expect(mockPagedInvoiceParams.calls.at(-1)).not.toHaveProperty("issuedFrom");
      expect(mockPagedInvoiceParams.calls.at(-1)).not.toHaveProperty("issuedTo");
      expect(ids(screen)).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds issued-date pickers and applies a valid range", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 20, 10));
      seed();
      const screen = await render(<InvoicesScreen />);
      await fireEvent.press(screen.getByTestId("filters-open"));
      await fireEvent.press(screen.getByTestId("date-option-custom"));

      await fireEvent.press(screen.getByTestId("issued-date-start"));
      await fireEvent.press(screen.getByTestId("issued-date-start-day-20"));
      await fireEvent.press(screen.getByTestId("issued-date-end"));
      expect(screen.getByTestId("issued-date-end-day-19").props.accessibilityState.disabled).toBe(true);
      expect(screen.getByTestId("issued-date-end-day-20").props.accessibilityState?.disabled).toBeFalsy();
      await fireEvent.press(screen.getByTestId("issued-date-end-day-21"));

      await fireEvent.press(screen.getByTestId("issued-date-start"));
      expect(screen.getByTestId("issued-date-start-day-22").props.accessibilityState.disabled).toBe(true);
      expect(screen.getByTestId("issued-date-start-day-21").props.accessibilityState?.disabled).toBeFalsy();
      await fireEvent.press(screen.getByTestId("issued-date-start-day-21"));
      expect(screen.getByTestId("invoice-filters-save").props.disabled).toBe(false);
      await fireEvent.press(screen.getByTestId("invoice-filters-save"));

      expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
        issuedFrom: "2026-10-21T00:00:00.000Z",
        issuedTo: "2026-10-22T00:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds custom aging pickers and applies a valid range", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 20, 10));
      seed();
      const screen = await render(<InvoicesScreen />);
      await fireEvent.press(screen.getByTestId("filters-open"));
      await fireEvent.press(screen.getByTestId("overdue-option-custom"));

      await fireEvent.press(screen.getByTestId("overdue-date-start"));
      await fireEvent.press(screen.getByTestId("overdue-date-start-day-10"));
      await fireEvent.press(screen.getByTestId("overdue-date-end"));
      expect(screen.getByTestId("overdue-date-end-day-9").props.accessibilityState.disabled).toBe(true);
      expect(screen.getByTestId("overdue-date-end-day-10").props.accessibilityState?.disabled).toBeFalsy();
      await fireEvent.press(screen.getByTestId("overdue-date-end-day-11"));

      await fireEvent.press(screen.getByTestId("overdue-date-start"));
      expect(screen.getByTestId("overdue-date-start-day-12").props.accessibilityState.disabled).toBe(true);
      expect(screen.getByTestId("overdue-date-start-day-11").props.accessibilityState?.disabled).toBeFalsy();
      await fireEvent.press(screen.getByTestId("overdue-date-start-day-11"));
      expect(screen.getByTestId("invoice-filters-save").props.disabled).toBe(false);
      await fireEvent.press(screen.getByTestId("invoice-filters-save"));

      expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
        dueDateFrom: "2026-10-11",
        dueDateTo: "2026-10-11",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      range: "issued",
      filters: { date: "custom" as const, dateStart: "2026-10-20", dateEnd: "2026-10-10" },
      field: "issued-date-start",
      validDay: "issued-date-start-day-10",
      saveParams: {
        issuedFrom: "2026-10-10T00:00:00.000Z",
        issuedTo: "2026-10-11T00:00:00.000Z",
      },
    },
    {
      range: "custom aging",
      filters: { overdue: "custom" as const, overdueStart: "2026-10-20", overdueEnd: "2026-10-10" },
      field: "overdue-date-end",
      validDay: "overdue-date-end-day-20",
      saveParams: { dueDateFrom: "2026-10-20", dueDateTo: "2026-10-20" },
    },
  ])("lets users correct an existing reversed $range range", async ({ filters, field, validDay, saveParams }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 20, 10));
      seed();
      seedInvoiceRegisterFiltersForTests(filters);
      const screen = await render(<InvoicesScreen />);
      await fireEvent.press(screen.getByTestId("filters-open"));
      await fireEvent.press(screen.getByTestId(field));
      await fireEvent.press(screen.getByTestId(validDay));

      expect(screen.getByTestId("invoice-filters-save").props.disabled).toBe(false);
      await fireEvent.press(screen.getByTestId("invoice-filters-save"));
      expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject(saveParams);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters paged rows by UTC issue day and displays midnight/noon without a local shift", async () => {
    seed();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 2, 1, 10));
      setMockAppState({
        invoicesPageSize: 1,
        invoices: [
          { id: "midnight", invoiceNumber: "MIDNIGHT", status: "open", total: 10, issuedAt: "2026-03-01T00:00:00.000Z" },
          { id: "noon", invoiceNumber: "NOON", status: "open", total: 10, issuedAt: "2026-03-01T12:00:00.000Z" },
          { id: "fallback", invoiceNumber: "FALLBACK", status: "open", total: 10, issuedAt: null, createdAt: "2026-03-01T23:00:00.000Z" },
          { id: "adjacent", invoiceNumber: "ADJACENT", status: "open", total: 10, issuedAt: "2026-03-02T00:00:00.000Z" },
        ],
      });
      const screen = await render(<InvoicesScreen />);
      await fireEvent.press(screen.getByTestId("filters-open"));
      await fireEvent.press(screen.getByTestId("date-option-today"));
      await fireEvent.press(screen.getByTestId("invoice-filters-save"));
      expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
        issuedFrom: "2026-03-01T00:00:00.000Z",
        issuedTo: "2026-03-02T00:00:00.000Z",
      });
      expect(mockPagedInvoiceParams.calls.at(-1)).not.toHaveProperty("dateFrom");
      expect(screen.getByText("3 invoices")).toBeTruthy();
      expect(screen.getByText(/Issued 03\/01\/2026/)).toBeTruthy();
      await fireEvent.press(screen.getByTestId("list-load-more"));
      expect(screen.getByTestId("invoice-noon")).toBeTruthy();
      await fireEvent.press(screen.getByTestId("list-load-more"));
      expect(screen.getByTestId("invoice-fallback")).toBeTruthy();
      expect(screen.queryByTestId("invoice-adjacent")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      preset: "today" as const,
      start: new Date(2026, 1, 28, 23, 59),
      before: ["2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
      after: ["2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"],
    },
    {
      preset: "yesterday" as const,
      start: new Date(2026, 11, 31, 23, 59),
      before: ["2026-12-30T00:00:00.000Z", "2026-12-31T00:00:00.000Z"],
      after: ["2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    },
  ])(
    "refreshes the selected $preset range at local midnight across calendar boundaries",
    async ({ preset, start, before, after }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(start);
        seed();
        setMockAppState({
          invoicesPageSize: 1,
          invoices: [before[0], after[0]].flatMap((day, dayIndex) =>
            [0, 1].map((rowIndex) => ({
              id: `midnight-${dayIndex}-${rowIndex}`,
              invoiceNumber: `MIDNIGHT-${dayIndex}-${rowIndex}`,
              status: "open",
              total: 10,
              balanceDue: 10,
              issuedAt: `${day.slice(0, 10)}T12:00:00.000Z`,
              labOrganizationId: "lab-1",
            })),
          ),
        });
        const screen = await render(<InvoicesScreen />);
        await fireEvent.press(screen.getByTestId("filters-open"));
        await fireEvent.press(screen.getByTestId(`date-option-${preset}`));
        await fireEvent.press(screen.getByTestId("invoice-filters-save"));

        expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
          issuedFrom: before[0],
          issuedTo: before[1],
        });
        expect(screen.getByTestId("invoice-midnight-0-0")).toBeTruthy();
        await fireEvent.press(screen.getByTestId("list-load-more"));
        expect(screen.getByTestId("invoice-midnight-0-1")).toBeTruthy();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });

        expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
          issuedFrom: after[0],
          issuedTo: after[1],
        });
        expect(screen.getByTestId("invoice-midnight-1-0")).toBeTruthy();
        expect(screen.queryByTestId("invoice-midnight-0-1")).toBeNull();
        await fireEvent.press(screen.getByTestId("filters-open"));
        expect(screen.getByTestId(`date-option-${preset}`).props.accessibilityState.checked)
          .toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    {
      preset: "today" as const,
      before: ["2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
      after: ["2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"],
      beforeDay: "2026-02-28",
      afterDay: "2026-03-01",
    },
    {
      preset: "yesterday" as const,
      before: ["2026-02-27T00:00:00.000Z", "2026-02-28T00:00:00.000Z"],
      after: ["2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
      beforeDay: "2026-02-27",
      afterDay: "2026-02-28",
    },
  ])("refreshes $preset and restarts paging after the device timezone changes on resume", async ({
    preset,
    before,
    after,
    beforeDay,
    afterDay,
  }) => {
    const originalTimeZone = process.env.TZ;
    const listeners: Array<(state: string) => void> = [];
    let appStateSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      process.env.TZ = "America/Los_Angeles";
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T05:00:00.000Z"));
      appStateSpy = vi.spyOn(AppState, "addEventListener").mockImplementation(((event, listener) => {
        if (event === "change") listeners.push(listener as unknown as (state: string) => void);
        return { remove: vi.fn() };
      }) as typeof AppState.addEventListener);
      setMockAppState({
        invoicesPageSize: 1,
        invoices: [beforeDay, afterDay].flatMap((day, dayIndex) =>
          [0, 1].map((rowIndex) => {
            const issuedAt = `${day}T${rowIndex === 0 ? "15:00:00" : "12:00:00"}.000Z`;
            return {
              id: `${dayIndex === 0 ? "before" : "after"}-${rowIndex}`,
              invoiceNumber: `${dayIndex === 0 ? "BEFORE" : "AFTER"}-${rowIndex}`,
              status: "open",
              total: 10,
              balanceDue: 10,
              issuedAt,
              createdAt: issuedAt,
              labOrganizationId: "lab-1",
            };
          }),
        ),
        meMemberships: [{
          organizationId: "lab-1",
          role: "admin",
          status: "active",
          organization: { type: "lab" },
        }],
      });

      const screen = await render(<InvoicesScreen />);
      await fireEvent.press(screen.getByTestId("filters-open"));
      await fireEvent.press(screen.getByTestId(`date-option-${preset}`));
      await fireEvent.press(screen.getByTestId("invoice-filters-save"));
      expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
        issuedFrom: before[0],
        issuedTo: before[1],
      });
      expect(screen.getByTestId("invoice-before-0")).toBeTruthy();
      await fireEvent.press(screen.getByTestId("list-load-more"));
      expect(screen.getByTestId("invoice-before-1")).toBeTruthy();

      process.env.TZ = "Pacific/Kiritimati";
      await act(async () => {
        listeners.forEach((listener) => listener("active"));
      });

      expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
        issuedFrom: after[0],
        issuedTo: after[1],
      });
      expect(screen.getByTestId("invoice-after-0")).toBeTruthy();
      expect(screen.queryByTestId("invoice-before-1")).toBeNull();
      expect(screen.queryByTestId("invoice-after-1")).toBeNull();
      await fireEvent.press(screen.getByTestId("filters-open"));
      expect(screen.getByTestId(`date-option-${preset}`).props.accessibilityState.checked)
        .toBe(true);
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
      appStateSpy?.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      transition: "spring-forward",
      preset: "today" as const,
      year: 2026,
      month: 2,
      day: 8,
      before: ["2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"],
      after: ["2026-03-09T00:00:00.000Z", "2026-03-10T00:00:00.000Z"],
    },
    {
      transition: "spring-forward",
      preset: "yesterday" as const,
      year: 2026,
      month: 2,
      day: 8,
      before: ["2026-03-07T00:00:00.000Z", "2026-03-08T00:00:00.000Z"],
      after: ["2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"],
    },
    {
      transition: "fall-back",
      preset: "today" as const,
      year: 2026,
      month: 10,
      day: 1,
      before: ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"],
      after: ["2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z"],
    },
    {
      transition: "fall-back",
      preset: "yesterday" as const,
      year: 2026,
      month: 10,
      day: 1,
      before: ["2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
      after: ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"],
    },
  ])(
    "refreshes $preset at local midnight on the $transition date",
    async ({ preset, year, month, day, before, after }) => {
      const previousTimezone = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(year, month, day, 23, 59));
        seed();
        setMockAppState({
          invoicesPageSize: 1,
          invoices: [before[0], after[0]].map((date, index) => ({
            id: `dst-invoice-${index}`,
            invoiceNumber: `DST-${index}`,
            status: "open",
            total: 10,
            balanceDue: 10,
            issuedAt: `${date.slice(0, 10)}T12:00:00.000Z`,
            labOrganizationId: "lab-1",
          })),
        });
        const screen = await render(<InvoicesScreen />);
        await fireEvent.press(screen.getByTestId("filters-open"));
        await fireEvent.press(screen.getByTestId(`date-option-${preset}`));
        await fireEvent.press(screen.getByTestId("invoice-filters-save"));

        expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
          issuedFrom: before[0],
          issuedTo: before[1],
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });

        expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
          issuedFrom: after[0],
          issuedTo: after[1],
        });
      } finally {
        vi.useRealTimers();
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
      }
    },
  );

  it("sends a same-day custom range with an exclusive next-day bound", async () => {
    seed();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 2, 1, 10));
      const screen = await render(<InvoicesScreen />);
      await fireEvent.press(screen.getByTestId("filters-open"));
      await fireEvent.press(screen.getByTestId("date-option-custom"));
      await fireEvent.press(screen.getByTestId("issued-date-start"));
      await fireEvent.press(screen.getByTestId("issued-date-start-day-1"));
      await fireEvent.press(screen.getByTestId("issued-date-end"));
      await fireEvent.press(screen.getByTestId("issued-date-end-day-1"));
      await fireEvent.press(screen.getByTestId("invoice-filters-save"));
      expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
        issuedFrom: "2026-03-01T00:00:00.000Z",
        issuedTo: "2026-03-02T00:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores search, view, filters, sort, and scroll after returning from an invoice", async () => {
    seed();
    const screen = await render(<InvoicesScreen />);
    await fireEvent.changeText(screen.getByTestId("invoice-search"), "INV");
    await fireEvent.press(screen.getByTestId("filters-open"));
    await fireEvent.press(screen.getByTestId("status-option-open"));
    await fireEvent(screen.getByTestId("ai-only-toggle"), "valueChange", true);
    await fireEvent.press(screen.getByTestId("invoice-filters-save"));
    await fireEvent.press(screen.getByTestId("sort-open"));
    await fireEvent.press(screen.getByTestId("sort-field-practice"));
    await fireEvent.press(screen.getByTestId("sort-direction-asc"));
    await fireEvent.press(screen.getByTestId("invoice-sort-save"));
    await fireEvent.scroll(screen.getByTestId("list-scroll"), {
      nativeEvent: { contentOffset: { y: 180 } },
    });
    await fireEvent.press(screen.getByTestId("invoice-open"));
    expect(router.push).toHaveBeenCalledWith("/invoice-editor/open");
    await screen.unmount();

    const returned = await render(<InvoicesScreen />);
    expect(returned.getByTestId("invoice-search").props.value).toBe("INV");
    expect(returned.queryByTestId("view-open")).toBeNull();
    expect(returned.getByTestId("list-scroll").props.contentOffset).toEqual({ x: 0, y: 180 });
    await fireEvent.press(returned.getByTestId("filters-open"));
    expect(returned.getByTestId("status-option-open").props.accessibilityState.checked).toBe(true);
    expect(returned.getByTestId("ai-only-toggle").props.value).toBe(true);
    await fireEvent.press(returned.getByTestId("invoice-filters-cancel"));
    await fireEvent.press(returned.getByTestId("sort-open"));
    expect(returned.getByTestId("sort-field-practice").props.accessibilityState.selected).toBe(true);
    expect(returned.getByTestId("sort-direction-asc").props.accessibilityState.selected).toBe(true);
  });

  it("does not restore invoice register state after the account scope changes", async () => {
    seed();
    const screen = await render(<InvoicesScreen />);
    await fireEvent.changeText(screen.getByTestId("invoice-search"), "INV-OPEN");
    await fireEvent.press(screen.getByTestId("filters-open"));
    await fireEvent.press(screen.getByTestId("status-option-open"));
    await fireEvent.press(screen.getByTestId("invoice-filters-save"));
    await fireEvent.scroll(screen.getByTestId("list-scroll"), {
      nativeEvent: { contentOffset: { y: 120 } },
    });

    setMockAppState({
      meMemberships: [{ organizationId: "lab-2", role: "admin", status: "active", organization: { type: "lab" } }],
    });
    await screen.rerender(<InvoicesScreen />);

    expect(screen.getByTestId("invoice-search").props.value).toBe("");
    expect(screen.queryByTestId("view-all")).toBeNull();
    await fireEvent.press(screen.getByTestId("filters-open"));
    expect(screen.getByTestId("status-option-all").props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId("list-scroll").props.contentOffset).toEqual({ x: 0, y: 0 });
  });
});
