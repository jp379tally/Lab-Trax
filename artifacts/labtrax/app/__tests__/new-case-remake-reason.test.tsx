import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";

import NewCaseScreen from "@/app/new-case";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";

afterEach(() => {
  cleanup();
  resetMockAppState();
  vi.clearAllMocks();
});

describe("NewCaseScreen — custom remake reason focus", () => {
  it("focuses Other's custom field and clears it when switching reasons", async () => {
    setMockAppState({
      meMemberships: [
        {
          id: "m-admin",
          role: "owner",
          status: "active",
          organizationId: "lab-1",
          organization: { id: "lab-1", name: "Acme Dental Lab", type: "lab" },
        },
      ],
      cases: [
        {
          id: "case-old",
          caseNumber: "5001",
          patientFirstName: "Jane",
          patientLastName: "Doe",
          doctorName: "Dr. Synthetic063",
          providerOrganizationId: "practice-1",
        },
      ],
    });

    const screen = await render(<NewCaseScreen />);
    await fireEvent.press(screen.getByTestId("new-case-remake-toggle"));
    await fireEvent.changeText(screen.getByTestId("remake-search"), "5001");
    await waitFor(() =>
      expect(screen.getByText("#5001 · Jane Doe")).toBeTruthy(),
    );
    await fireEvent.press(screen.getByText("#5001 · Jane Doe"));
    await fireEvent.press(screen.getByTestId("new-case-remake-reason-other"));

    expect(
      screen.getByTestId("new-case-custom-remake-reason").props.autoFocus,
    ).toBe(true);
    expect(
      screen.getByTestId("new-case-keyboard-aware-scroll").props.bottomOffset,
    ).toBe(72);

    await fireEvent.press(
      screen.getByTestId("new-case-remake-reason-shade_wrong"),
    );
    expect(screen.queryByTestId("new-case-custom-remake-reason")).toBeNull();
  });
});