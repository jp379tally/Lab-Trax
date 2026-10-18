import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react-native";

import NewCaseScreen from "@/app/new-case";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";

afterEach(() => {
  cleanup();
  resetMockAppState();
});

describe("NewCaseScreen — section layout", () => {
  it("keeps case fields grouped and the primary action in the sticky footer", async () => {
    setMockAppState({
      meMemberships: [
        {
          id: "m1",
          role: "owner",
          status: "active",
          organizationId: "lab-1",
          organization: { id: "lab-1", name: "Acme Dental Lab", type: "lab" },
        },
      ],
    });

    const screen = await render(<NewCaseScreen />);
    const patientSection = within(screen.getByTestId("new-case-patient-section"));
    const restorationsSection = within(screen.getByTestId("new-case-restorations-section"));
    const scheduleSection = within(screen.getByTestId("new-case-schedule-section"));
    const detailsSection = within(screen.getByTestId("new-case-details-section"));

    expect(patientSection.getByTestId("new-case-number")).toBeTruthy();
    expect(patientSection.getByTestId("new-case-patient-first")).toBeTruthy();
    expect(patientSection.getByTestId("new-case-patient-last")).toBeTruthy();
    expect(patientSection.getByTestId("new-case-doctor")).toBeTruthy();
    expect(patientSection.getByText("Acme Dental Lab")).toBeTruthy();

    expect(restorationsSection.getByTestId("add-restoration")).toBeTruthy();
    expect(restorationsSection.getByTestId("resto-category-0")).toBeTruthy();
    expect(scheduleSection.getByTestId("new-case-received-date")).toBeTruthy();
    expect(scheduleSection.getByTestId("new-case-due-date")).toBeTruthy();
    expect(scheduleSection.getByTestId("priority-normal")).toBeTruthy();
    expect(detailsSection.getByTestId("new-case-notes")).toBeTruthy();
    expect(detailsSection.getByTestId("new-case-barcode")).toBeTruthy();
    expect(detailsSection.getByTestId("new-case-remake-toggle")).toBeTruthy();

    expect(screen.getByTestId("new-case-sticky-footer")).toBeTruthy();
    expect(screen.getByTestId("new-case-keyboard-aware-scroll").props.style).toEqual({
      flex: 1,
    });
    expect(screen.getByTestId("new-case-save").props.accessibilityRole).toBe("button");
    expect(screen.getByText("Create Case")).toBeTruthy();
    expect(screen.queryByTestId("new-case-submit")).toBeNull();
  });
});
