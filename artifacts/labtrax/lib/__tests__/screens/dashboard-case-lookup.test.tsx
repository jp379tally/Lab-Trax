import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
} from "../../../vitest.setup";

import DashboardScreen from "@/app/(tabs)/dashboard";

/**
 * Dashboard action row.
 *
 * "Look Up Case" used to route straight into the AI Rx capture screen, which
 * opened the camera full-screen. It now opens the case-lookup pop-up instead,
 * and the AI Rx flow — whose only entry point in the app this is — moved onto
 * its own "Scan Rx" button that keeps the original testID.
 */

const LAB_MEMBERSHIP = {
  organizationId: "lab-org-dashboard",
  status: "active",
  role: "admin",
  organization: { type: "lab" },
};

beforeEach(() => {
  setMockAppState({ meMemberships: [LAB_MEMBERSHIP], cases: [], recentCases: [] });
});

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("Dashboard — Look Up Case", () => {
  it("opens the lookup pop-up instead of navigating to the Rx camera", async () => {
    const { router } = await import("expo-router");
    const { getByTestId, queryByTestId } = await render(<DashboardScreen />);

    expect(queryByTestId("case-lookup-sheet")).toBeNull();

    await fireEvent.press(getByTestId("dashboard-case-lookup-btn"));

    expect(getByTestId("case-lookup-sheet")).toBeTruthy();
    expect(getByTestId("case-lookup-search")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps the AI Rx capture flow reachable from the Scan Rx button", async () => {
    const { router } = await import("expo-router");
    const { getByTestId } = await render(<DashboardScreen />);

    await fireEvent.press(getByTestId("dashboard-ai-reader-btn"));

    expect(router.push).toHaveBeenCalledWith("/ai-reader/capture?new=1");
  });
});
