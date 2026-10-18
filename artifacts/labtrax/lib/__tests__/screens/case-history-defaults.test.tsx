import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import {
  flushPendingReactUpdates,
  resetMockAppState,
  setMockAppState,
  setMockSearchParams,
} from "../../../vitest.setup";
import CaseDetailScreen from "@/app/case/[id]";
import * as ExpoRouter from "expo-router";
import * as ApiClient from "@workspace/api-client-react";
import { inProgressCase, caseWithNoteHistory } from "./__fixtures__/cases";

const lifecycle = {
  loading: false,
  focus: [] as Array<() => unknown>,
};
const useHarnessFocusEffect = ExpoRouter.useFocusEffect;
const useHarnessCase = ApiClient.useCase;

beforeEach(() => {
  lifecycle.loading = false;
  lifecycle.focus = [];
  vi.spyOn(ExpoRouter, "useFocusEffect").mockImplementation((callback) => {
    lifecycle.focus.push(callback);
    useHarnessFocusEffect(callback);
  });
  vi.spyOn(ApiClient, "useCase").mockImplementation((...args) => ({
    ...useHarnessCase(...args),
    isLoading: lifecycle.loading,
  } as ReturnType<typeof ApiClient.useCase>));
  setMockSearchParams({ id: inProgressCase.id });
  setMockAppState({ cases: [inProgressCase, caseWithNoteHistory], invoices: [] });
});

afterEach(async () => {
  await flushPendingReactUpdates();
  await cleanup();
  resetMockAppState();
  setMockSearchParams({});
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("ordinary mobile case presentation", () => {
  it("opens on Overview without a tab press", async () => {
    lifecycle.loading = true;
    setMockSearchParams({ id: caseWithNoteHistory.id });
    const screen = await render(<CaseDetailScreen />);
    expect(screen.queryByTestId("section-tab-overview")).toBeNull();
    lifecycle.loading = false;
    await screen.rerender(<CaseDetailScreen />);
    expect(screen.getByTestId("section-tab-overview").props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId("section-tab-history").props.accessibilityState.selected).toBe(false);
  });

  it("preserves a manually chosen section and edits across refresh and focus", async () => {
    const editableCase = { ...inProgressCase, organizationId: "org-1", labOrganizationId: "org-1", viewerCanPostNotes: true };
    setMockAppState({
      cases: [editableCase, caseWithNoteHistory],
      meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
    });
    const screen = await render(<CaseDetailScreen />);
    expect(screen.getByTestId("section-tab-overview").props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByTestId("section-tab-notes"));
    const input = screen.getByTestId("note-input");
    await fireEvent.changeText(input, "Unsaved note");
    setMockAppState({ cases: [{ ...editableCase, patientFirstName: "Refreshed" }, caseWithNoteHistory] });
    await screen.rerender(<CaseDetailScreen />);
    // Exercise the screen's actual focus refresh callback without remounting.
    await act(async () => { lifecycle.focus[0]!(); });
    expect(screen.getByTestId("section-tab-notes").props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId("note-input").props.value).toBe("Unsaved note");
  });

  it("starts reused routes and reopened presentations on Overview", async () => {
    const screen = await render(<CaseDetailScreen />);
    await fireEvent.press(screen.getByTestId("section-tab-files"));
    setMockSearchParams({ id: caseWithNoteHistory.id });
    await screen.rerender(<CaseDetailScreen />);
    expect(screen.getByTestId("section-tab-overview").props.accessibilityState.selected).toBe(true);
    await screen.unmount();
    const reopened = await render(<CaseDetailScreen />);
    expect(reopened.getByTestId("section-tab-overview").props.accessibilityState.selected).toBe(true);
  });

  it("shows the existing History empty state", async () => {
    setMockAppState({ cases: [{ ...inProgressCase, events: [], originalCaseEvents: [], remakeChildrenEvents: [] }] });
    const screen = await render(<CaseDetailScreen />);
    expect(screen.getByTestId("section-tab-overview").props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByTestId("section-tab-history"));
    expect(screen.getByTestId("section-tab-history").props.accessibilityState.selected).toBe(true);
    expect(screen.getByText("No history yet.")).toBeTruthy();
  });
});
