import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react-native";
import { router } from "expo-router";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";
import DashboardScreen from "../(tabs)/dashboard";
import { DASHBOARD_SECTION_LABELS } from "@workspace/dashboard-labels";

/**
 * Mobile dashboard — Exception Cases section.
 *
 * Mirrors the desktop card: the same active queue (canonical AND legacy
 * mobile-originated cases), the same identity/issue/age/author/media
 * information, and a tap that opens the EXISTING case detail screen rather
 * than a mobile-only exception view.
 *
 * The section is gated on lab membership, not on admin — anyone in the lab can
 * flag a case, so everyone must be able to see what is currently flagged.
 */

const LAB_MEMBERSHIP = {
  organizationId: "lab_1",
  role: "technician",
  status: "active",
  organization: { id: "lab_1", type: "lab", name: "Test Lab" },
};

function makeException(overrides: Record<string, unknown> = {}) {
  return {
    id: "exc_1",
    labOrganizationId: "lab_1",
    caseId: "case_1",
    caseKind: "canonical",
    status: "active",
    issueText: "Margin is short on #14",
    createdByUserId: "user_1",
    createdByName: "Tina Tech",
    createdAt: new Date().toISOString(),
    caseNumber: "SYN-CASE-001",
    patientFirstName: "Ada",
    patientLastName: "Lovelace",
    doctorName: "Dr. Synthetic042",
    caseStatus: "on_hold",
    mediaCount: 0,
    hasMedia: false,
    noteCount: 0,
    latestNoteText: null,
    latestNoteAuthorName: null,
    latestNoteCreatedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  resetMockAppState();
});

describe("Mobile dashboard — Exception cases", () => {
  it("uses matching title case for section headings and dynamic summary cards", async () => {
    setMockAppState({
      meMemberships: [LAB_MEMBERSHIP],
      caseExceptions: [makeException()],
    });

    const { getAllByText, getByText, getByTestId, queryByText } = await render(
      <DashboardScreen />,
    );

    expect(getByText(DASHBOARD_SECTION_LABELS.recentCases)).toBeTruthy();
    expect(getByText(DASHBOARD_SECTION_LABELS.exceptionCases)).toBeTruthy();
    expect(
      getAllByText(DASHBOARD_SECTION_LABELS.pastDue).length,
    ).toBeGreaterThan(0);
    expect(
      getAllByText(DASHBOARD_SECTION_LABELS.dueToday).length,
    ).toBeGreaterThan(0);
    expect(
      getAllByText(DASHBOARD_SECTION_LABELS.dueTomorrow).length,
    ).toBeGreaterThan(0);
    expect(
      getAllByText(DASHBOARD_SECTION_LABELS.unassignedDocuments).length,
    ).toBeGreaterThan(0);
    expect(
      within(getByTestId("dashboard-summary-past-due")).getByText(
        DASHBOARD_SECTION_LABELS.pastDue,
      ),
    ).toBeTruthy();
    expect(
      within(getByTestId("dashboard-summary-due-today")).getByText(
        DASHBOARD_SECTION_LABELS.dueToday,
      ),
    ).toBeTruthy();
    expect(
      within(getByTestId("dashboard-summary-due-tomorrow")).getByText(
        DASHBOARD_SECTION_LABELS.dueTomorrow,
      ),
    ).toBeTruthy();
    expect(
      within(getByTestId("dashboard-summary-unassigned")).getByText(
        DASHBOARD_SECTION_LABELS.unassignedDocuments,
      ),
    ).toBeTruthy();
    expect(getByText("RX Intake")).toBeTruthy();
    expect(queryByText("Recent cases")).toBeNull();
    expect(queryByText("Exception cases")).toBeNull();
  });

  it("renders the queue with patient, case, issue, author and a media indicator", async () => {
    setMockAppState({
      meMemberships: [LAB_MEMBERSHIP],
      caseExceptions: [
        makeException(),
        makeException({
          id: "exc_2",
          caseId: "legacy_2",
          caseKind: "legacy",
          caseNumber: "MOB-77",
          patientFirstName: "Legacy",
          patientLastName: "Mobile",
          issueText: "Wrong shade sent",
          hasMedia: true,
          mediaCount: 2,
        }),
      ],
    });

    const { getByTestId, getByText, queryByTestId } = await render(
      <DashboardScreen />,
    );

    expect(getByTestId("dashboard-exception-cases")).toBeTruthy();
    expect(getByTestId("dashboard-exception-count").props.children).toBe(2);
    expect(getByText("Ada Lovelace")).toBeTruthy();
    expect(
      getByTestId("dashboard-exception-location-exc_1").props.children,
    ).toContain("On Hold");
    expect(getByText("Margin is short on #14")).toBeTruthy();
    // Legacy mobile cases share the queue with canonical ones.
    expect(getByText("Legacy Mobile")).toBeTruthy();

    // Only the row with media gets the attach icon.
    expect(getByTestId("dashboard-exception-media-exc_2")).toBeTruthy();
    expect(queryByTestId("dashboard-exception-media-exc_1")).toBeNull();
  });

  it("uses the canonical status label when no live location row is available", async () => {
    setMockAppState({
      meMemberships: [LAB_MEMBERSHIP],
      caseExceptions: [
        makeException({ currentLocationName: null, caseStatus: "in_design" }),
      ],
    });
    const { getByTestId } = await render(<DashboardScreen />);
    expect(
      getByTestId("dashboard-exception-location-exc_1").props.children,
    ).toContain("In Design");
  });

  it("previews the newest follow-up note with its matching author", async () => {
    const openerAt = new Date();
    openerAt.setDate(openerAt.getDate() - 5);
    const latestNoteAt = new Date();
    latestNoteAt.setDate(latestNoteAt.getDate() - 1);
    setMockAppState({
      meMemberships: [LAB_MEMBERSHIP],
      caseExceptions: [
        makeException({
          noteCount: 2,
          createdAt: openerAt.toISOString(),
          latestNoteText: "Newest conversation update",
          latestNoteAuthorName: "Olive Owner",
          latestNoteCreatedAt: latestNoteAt.toISOString(),
        }),
      ],
    });
    const { getByText, queryByText } = await render(<DashboardScreen />);
    expect(getByText("Newest conversation update")).toBeTruthy();
    expect(getByText(/Olive Owner/)).toBeTruthy();
    expect(getByText(/Created yesterday/)).toBeTruthy();
    expect(queryByText("Margin is short on #14")).toBeNull();
    expect(queryByText(/Tina Tech/)).toBeNull();
    expect(queryByText(/Created 5 days ago/)).toBeNull();
  });

  it("renders the current live location returned after an exception case moves", async () => {
    setMockAppState({
      meMemberships: [LAB_MEMBERSHIP],
      caseExceptions: [
        makeException({
          currentLocationId: "loc_polish",
          currentLocationName: "Polishing Bench",
          currentLocationStatus: "qc",
        }),
      ],
    });
    const { getByTestId } = await render(<DashboardScreen />);
    expect(
      getByTestId("dashboard-exception-location-exc_1").props.children,
    ).toContain("Polishing Bench");
  });

  it("opens the existing case detail screen for the tapped exception", async () => {
    setMockAppState({
      meMemberships: [LAB_MEMBERSHIP],
      caseExceptions: [makeException()],
    });

    const { getByTestId } = await render(<DashboardScreen />);
    await fireEvent.press(getByTestId("dashboard-exception-row-exc_1"));
    expect(router.push).toHaveBeenCalledWith("/case/case_1");
  });

  it("shows an explicit empty state instead of hiding the section", async () => {
    setMockAppState({ meMemberships: [LAB_MEMBERSHIP], caseExceptions: [] });

    const { getByTestId, getByText, queryByTestId } = await render(
      <DashboardScreen />,
    );
    expect(getByTestId("dashboard-exception-empty")).toBeTruthy();
    expect(
      getByText(
        "No exception cases right now.",
      ),
    ).toBeTruthy();
    expect(queryByTestId("dashboard-exception-count")).toBeNull();
  });

  it("shows a loading state rather than an empty queue while fetching", async () => {
    setMockAppState({
      meMemberships: [LAB_MEMBERSHIP],
      caseExceptionsIsLoading: true,
    });
    const { getByTestId, queryByTestId } = await render(<DashboardScreen />);
    expect(getByTestId("dashboard-exception-loading")).toBeTruthy();
    expect(queryByTestId("dashboard-exception-empty")).toBeNull();
  });

  it("shows an error state rather than an empty queue when the fetch fails", async () => {
    setMockAppState({
      meMemberships: [LAB_MEMBERSHIP],
      caseExceptionsIsError: true,
    });
    const { getByTestId, queryByTestId } = await render(<DashboardScreen />);
    expect(getByTestId("dashboard-exception-error")).toBeTruthy();
    expect(queryByTestId("dashboard-exception-empty")).toBeNull();
  });

  it("collapses and expands the section", async () => {
    setMockAppState({
      meMemberships: [LAB_MEMBERSHIP],
      caseExceptions: [makeException()],
    });

    const { getByTestId, getByText, queryByTestId } = await render(
      <DashboardScreen />,
    );
    expect(getByTestId("dashboard-exception-row-exc_1")).toBeTruthy();

    await fireEvent.press(getByText("Exception Cases"));
    expect(queryByTestId("dashboard-exception-row-exc_1")).toBeNull();

    await fireEvent.press(getByText("Exception Cases"));
    expect(getByTestId("dashboard-exception-row-exc_1")).toBeTruthy();
  });

  it("hides the section entirely for a viewer with no active lab membership", async () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "prov_1",
          role: "owner",
          status: "active",
          organization: { id: "prov_1", type: "provider", name: "Practice" },
        },
      ],
      caseExceptions: [makeException()],
    });

    const { queryByTestId } = await render(<DashboardScreen />);
    expect(queryByTestId("dashboard-exception-cases")).toBeNull();
  });
});
