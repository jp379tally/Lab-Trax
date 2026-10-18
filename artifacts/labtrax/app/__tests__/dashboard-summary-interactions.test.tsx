import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import * as apiClient from "@workspace/api-client-react";
import * as authMe from "@/lib/auth-me";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";
import DashboardScreen from "../(tabs)/dashboard";
import { subscribeRxIntake } from "@/lib/rx-intake-events";

const membership = {
  organizationId: "summary-lab", role: "user", status: "active",
  organization: { id: "summary-lab", type: "lab", name: "Summary lab" },
};

afterEach(async () => {
  await cleanup();
  resetMockAppState();
  vi.restoreAllMocks();
  vi.mocked(router.push).mockClear();
});

describe("native dashboard summary interactions", () => {
  it("reveals the empty past-due queue when its zero-count card is pressed", async () => {
    setMockAppState({ meMemberships: [membership], cases: [] });
    const view = await render(<DashboardScreen />);
    await fireEvent.press(view.getByLabelText("Collapse past due"));
    expect(view.queryByText("No active cases past due.")).toBeNull();
    await fireEvent.press(view.getByTestId("dashboard-summary-past-due"));
    expect(view.getByLabelText("Collapse past due")).toBeTruthy();
    expect(view.getByText("No active cases past due.")).toBeTruthy();
    await fireEvent.press(view.getByLabelText("Collapse due today"));
    await fireEvent.press(view.getByTestId("dashboard-summary-due-today"));
    expect(view.getByText("Nothing due today.")).toBeTruthy();
  });

  it.each(["loading", "error"])("does not present failed or pending counts as zero (%s)", async (state) => {
    setMockAppState({ meMemberships: [membership] });
    const refetch = vi.fn(async () => ({}));
    vi.spyOn(apiClient, "useCases").mockReturnValue({
      data: undefined, isLoading: state === "loading", isError: state === "error",
      refetch,
    } as unknown as ReturnType<typeof apiClient.useCases>);
    const view = await render(<DashboardScreen />);
    expect(view.getByTestId("dashboard-summary-past-due")).toBeTruthy();
    expect(view.queryByLabelText("Past due: 0")).toBeNull();
    expect(view.queryByText("No active cases past due.")).toBeNull();
    expect(view.queryByText("Nothing due today.")).toBeNull();
    if (state === "error") {
      await fireEvent.press(view.getByTestId("dashboard-summary-past-due"));
      expect(refetch).toHaveBeenCalledTimes(1);
    } else {
      expect(view.getByLabelText("Past due: loading")).toBeTruthy();
    }
  });

  it("routes Add case and passes RX actions to the existing intake controller", async () => {
    setMockAppState({ meMemberships: [membership] });
    const actions: string[] = [];
    const unsubscribe = subscribeRxIntake((action) => actions.push(action));
    try {
      const view = await render(<DashboardScreen />);
      await fireEvent.press(view.getByTestId("dashboard-add-case-btn"));
      expect(router.push).toHaveBeenCalledWith("/new-case");
      await fireEvent.press(view.getByTestId("dashboard-rx-browse-btn"));
      await fireEvent.press(view.getByTestId("dashboard-rx-capture-btn"));
      await fireEvent.press(view.getByTestId("dashboard-summary-unassigned"));
      expect(actions).toEqual(["browse", "photo", "reveal"]);
      expect(view.getByTestId("dashboard-batch-locate-btn")).toBeTruthy();
      expect(view.getByTestId("dashboard-case-lookup-btn")).toBeTruthy();
      expect(view.getByTestId("dashboard-ai-reader-btn")).toBeTruthy();
      expect(view.queryByLabelText("Today's sales — tap to open finance report")).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it("does not show zero documents when the lab profile failed to load", async () => {
    const refetch = vi.fn(async () => ({}));
    vi.spyOn(authMe, "useMe").mockReturnValue({
      data: undefined, isLoading: false, isError: true, refetch,
    } as unknown as ReturnType<typeof authMe.useMe>);
    const view = await render(<DashboardScreen />);
    expect(view.getByLabelText("Unassigned documents count unavailable, tap to retry")).toBeTruthy();
    expect(view.queryByLabelText("Unassigned documents: 0")).toBeNull();
    await fireEvent.press(view.getByTestId("dashboard-summary-unassigned"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the case number, station and operational status independently", async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    setMockAppState({
      meMemberships: [membership],
      cases: [{
        id: "identity-case", caseNumber: "26-2468", status: "in_design",
        patientFirstName: "Sample", patientLastName: "Patient",
        doctorName: "Dr. Example", dueDate: today, labLocationName: "Wax Room",
        createdAt: now.toISOString(),
      }],
    });
    const view = await render(<DashboardScreen />);
    expect(view.getByTestId("dashboard-case-number-identity-case").props.children).toBe("26-2468");
    expect(view.getByText("Wax Room")).toBeTruthy();
    expect(view.getByText("IN DESIGN")).toBeTruthy();
    expect(view.getByText("Sample Patient")).toBeTruthy();
    expect(view.getByText("Dr. Example")).toBeTruthy();
  });

  it("keeps the real intake controller ready while cases are loading", async () => {
    setMockAppState({ meMemberships: [membership] });
    vi.spyOn(apiClient, "useCases").mockReturnValue({
      data: undefined, isLoading: true, isError: false, refetch: vi.fn(),
    } as unknown as ReturnType<typeof apiClient.useCases>);
    vi.mocked(DocumentPicker.getDocumentAsync).mockClear();
    vi.mocked(ImagePicker.launchCameraAsync).mockClear();
    const view = await render(<DashboardScreen />);
    await fireEvent.press(view.getByTestId("dashboard-rx-browse-btn"));
    await waitFor(() => expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledTimes(1));
    await fireEvent.press(view.getByTestId("dashboard-rx-capture-btn"));
    await waitFor(() => expect(ImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1));
    await fireEvent.press(view.getByTestId("dashboard-summary-unassigned"));
    expect(view.getByTestId("dashboard-scroll")).toBeTruthy();
  });

  it("places all dashboard controls and queues in one flexible scroll viewport", async () => {
    setMockAppState({ meMemberships: [membership], cases: [] });
    const view = await render(<DashboardScreen />);
    const scroll = view.getByTestId("dashboard-scroll");
    const withinScroll = (node: typeof scroll): boolean => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent === scroll) return true;
      }
      return false;
    };
    for (const id of [
      "dashboard-add-case-btn", "dashboard-summary-past-due",
      "dashboard-summary-unassigned", "dashboard-rx-browse-btn",
      "dashboard-batch-locate-btn", "dashboard-case-lookup-btn",
      "dashboard-ai-reader-btn", "dashboard-section-past-due", "dashboard-section-due-today",
    ]) {
      expect(withinScroll(view.getByTestId(id)), `${id} must scroll away on short phones`).toBe(true);
    }
    expect(scroll.props.style).toMatchObject({ flex: 1, minHeight: 0 });
    expect(withinScroll(view.getByTestId("dashboard-profile-header"))).toBe(false);
  });
});
