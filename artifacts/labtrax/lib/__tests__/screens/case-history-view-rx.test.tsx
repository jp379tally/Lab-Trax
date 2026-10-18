import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it as vitestIt,
  vi,
} from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import {
  flushPendingReactUpdates,
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockSearchParams,
} from "../../../vitest.setup";

import CaseDetailScreen from "@/app/case/[id]";

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => Object.assign(acc, flatten(entry)),
      {},
    );
  }
  return (style ?? {}) as Record<string, unknown>;
}

/**
 * Mobile case History — "View Rx" on returned-case entries (desktop parity)
 *
 * When a finished case comes back into the lab, the timeline shows a
 * completion-family status followed by an intake-family status and already
 * draws a "Case returned" divider. Those rows (and only those rows) carry a
 * "View Rx" button that opens the case screen's existing Prescription Preview
 * modal, matching the desktop History tab's wording and detection rule.
 */

const CASE_ID = "case-returned-mobile";

function statusEvent(
  id: string,
  fromStatus: string | null,
  toStatus: string,
  occurredAt: string,
) {
  return {
    id,
    eventType: "status_changed",
    actorInitials: "RT",
    occurredAt,
    metadataJson: fromStatus ? { fromStatus, toStatus } : { toStatus },
  };
}

function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

/** The very first "Received" entry of a brand-new case. */
const FIRST_RECEIVED = statusEvent("evt-first-received", null, "received", "2026-02-01T10:00:00.000Z");
/** An ordinary location change. */
const ORDINARY_MOVE = statusEvent("evt-ordinary", "received", "in_progress", "2026-02-02T10:00:00.000Z");
const MARKED_COMPLETE = statusEvent("evt-complete", "in_progress", "complete", "2026-02-03T10:00:00.000Z");
/** The case coming back into the lab. */
const RETURN_EVENT = statusEvent("evt-return", "complete", "received", "2026-02-04T10:00:00.000Z");

const returnedCase = {
  id: CASE_ID,
  caseNumber: "7001",
  patientFirstName: "Rita",
  patientLastName: "Turner",
  doctorName: "Dr. Back",
  status: "received",
  priority: "standard",
  dueDate: "2026-02-20",
  createdAt: "2026-02-01T10:00:00.000Z",
  updatedAt: "2026-02-04T10:00:00.000Z",
  restorations: [
    {
      id: "rest-1",
      toothNumber: "8",
      restorationType: "crown",
      material: "Zirconia",
      shade: "A2",
      quantity: 1,
    },
  ],
  notes: [],
  events: [FIRST_RECEIVED, ORDINARY_MOVE, MARKED_COMPLETE, RETURN_EVENT],
};

const it = (
  name: string,
  testFn: () => void | Promise<void>,
  timeout?: number,
): void => {
  vitestIt(
    name,
    async () => {
      await testFn();
      await flushPendingReactUpdates();
    },
    timeout,
  );
};

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("CaseDetailScreen — View Rx on returned-case history entries", () => {
  beforeEach(() => {
    setMockSearchParams({ id: CASE_ID });
    setMockAppState({ cases: [returnedCase], invoices: [] });
  });

  it("shows a View Rx button on the completion→intake entry", async () => {
    const { getByTestId, getAllByTestId, queryAllByTestId, getAllByText } = await render(
      <CaseDetailScreen />,
    );
    await fireEvent.press(getByTestId("section-tab-history"));

    expect(getByTestId(`history-view-rx-${RETURN_EVENT.id}`)).toBeTruthy();
    // Same wording as desktop, alongside the existing divider.
    expect(getAllByText("View Rx").length).toBeGreaterThan(0);
    expect(getAllByText("Case returned")).toHaveLength(1);
    expect(getAllByTestId("history-day-header")).toHaveLength(4);
    expect(queryAllByTestId("history-date-separator")).toHaveLength(3);
  });

  it("does not show View Rx on an ordinary location change or a first-ever Received entry", async () => {
    const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
    await fireEvent.press(getByTestId("section-tab-history"));

    expect(queryByTestId(`history-view-rx-${FIRST_RECEIVED.id}`)).toBeNull();
    expect(queryByTestId(`history-view-rx-${ORDINARY_MOVE.id}`)).toBeNull();
    expect(queryByTestId(`history-view-rx-${MARKED_COMPLETE.id}`)).toBeNull();
  });

  it("opens the Prescription Preview modal when pressed", async () => {
    const { getByTestId, queryAllByText, getAllByText } = await render(<CaseDetailScreen />);
    await fireEvent.press(getByTestId("section-tab-history"));

    expect(queryAllByText("Prescription Preview").length).toBe(0);

    await fireEvent.press(getByTestId(`history-view-rx-${RETURN_EVENT.id}`));

    expect(getAllByText("Prescription Preview").length).toBeGreaterThan(0);
  });

  it("renders bold headers and one strong separator per calendar-day transition", async () => {
    const sameAndDifferentDayEvents = [
      statusEvent("evt-day-1-late", "received", "in_progress", "2026-08-12T16:00:00.000Z"),
      statusEvent("evt-day-1-early", "in_progress", "in_review", "2026-08-12T09:00:00.000Z"),
      statusEvent("evt-day-2-late", "in_review", "ready", "2026-08-13T16:00:00.000Z"),
      statusEvent("evt-day-2-early", "ready", "shipped", "2026-08-13T09:00:00.000Z"),
      statusEvent("evt-day-3", "shipped", "complete", "2026-08-14T09:00:00.000Z"),
    ];
    setMockAppState({
      cases: [{ ...returnedCase, events: sameAndDifferentDayEvents }],
      invoices: [],
    });

    const { getByTestId, getAllByTestId, queryAllByTestId, getAllByText } = await render(
      <CaseDetailScreen />,
    );
    await fireEvent.press(getByTestId("section-tab-history"));

    const headers = getAllByTestId("history-day-header");
    expect(headers).toHaveLength(3);
    expect(flatten(headers[0].props.style)).toMatchObject({
      fontSize: 16,
      fontFamily: "Inter_600SemiBold",
    });
    expect(getAllByText(/08\/12\/2026/).length).toBeGreaterThan(0);
    expect(getAllByText(/08\/13\/2026/).length).toBeGreaterThan(0);
    expect(getAllByText(/08\/14\/2026/).length).toBeGreaterThan(0);
    const separators = queryAllByTestId("history-date-separator");
    expect(separators).toHaveLength(2);
    expect(flatten(separators[0].props.style)).toMatchObject({
      borderTopWidth: 2,
    });
  });

  it("shows actor and time only in event metadata, including around local midnight", async () => {
    const events = [
      statusEvent(
        "evt-before-midnight",
        "received",
        "in_progress",
        localIso(2026, 8, 12, 23, 59),
      ),
      statusEvent(
        "evt-after-midnight",
        "in_progress",
        "in_review",
        localIso(2026, 8, 13, 0, 1),
      ),
    ];
    setMockAppState({
      cases: [{ ...returnedCase, events }],
      invoices: [],
    });

    const { getByTestId, getAllByTestId } = await render(<CaseDetailScreen />);
    await fireEvent.press(getByTestId("section-tab-history"));

    expect(getAllByTestId("history-day-header")).toHaveLength(2);
    expect(getAllByTestId("history-day-header")[0].props.children).toMatch(/\d{2}\/\d{2}\/2026/);
    expect(getByTestId("history-event-meta-evt-before-midnight").props.children).toEqual([
      "RT · ",
      "11:59 PM",
    ]);
    expect(getByTestId("history-event-meta-evt-before-midnight").props.children).not.toContain(
      "08/12/2026",
    );
  });
});
