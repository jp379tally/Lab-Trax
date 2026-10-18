import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { resetMockFetchHandler, setMockFetchHandler } from "../../vitest.setup";

const state = vi.hoisted(() => ({
  data: {
    occlusionAmount: 0.2,
    occlusionUnit: "mm",
    proximalContactAmount: 40,
    proximalContactUnit: "microns",
    anatomyPreference: "other",
    anatomyOther: "Match the adjacent central",
    caseQuestionContactMethod: "email",
    caseQuestionContactValue: "doctor@example.com",
  },
  mutationOptions: null as null | {
    mutationFn: (variables: { draft: unknown; userId: string }) => Promise<unknown>;
    onSuccess?: (data: unknown, variables: { draft: unknown; userId: string }) => void;
  },
  mutate: vi.fn(),
  currentUserId: "provider-a",
}));

const INITIAL_DATA = {
  occlusionAmount: 0.2,
  occlusionUnit: "mm",
  proximalContactAmount: 40,
  proximalContactUnit: "microns",
  anatomyPreference: "other",
  anatomyOther: "Match the adjacent central",
  caseQuestionContactMethod: "email",
  caseQuestionContactValue: "doctor@example.com",
};

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAwareScrollView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ currentUserId: state.currentUserId }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({
      data: state.data,
      isLoading: false,
      error: null,
    })),
    useQueryClient: vi.fn(() => ({ setQueryData: vi.fn() })),
    useMutation: vi.fn((options) => {
      state.mutationOptions = options;
      return {
        mutate: state.mutate,
        isPending: false,
        isSuccess: false,
        error: null,
      };
    }),
  };
});

import DoctorPreferencesScreen from "../settings/doctor-preferences";

beforeEach(() => {
  state.data = { ...INITIAL_DATA };
  state.currentUserId = "provider-a";
  state.mutate.mockClear();
  resetMockFetchHandler();
});
afterEach(() => {
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("DoctorPreferencesScreen", () => {
  it("prefills values and enforces the 100-character anatomy limit", async () => {
    await render(<DoctorPreferencesScreen />);
    expect(screen.getByDisplayValue("0.2")).toBeTruthy();
    const other = screen.getByDisplayValue("Match the adjacent central");
    expect(other.props.maxLength).toBe(100);
    expect(screen.getByDisplayValue("doctor@example.com")).toBeTruthy();
  });

  it("shows and validates the matching contact input", async () => {
    await render(<DoctorPreferencesScreen />);
    await fireEvent.press(screen.getByText("Text"));
    await fireEvent.changeText(screen.getByLabelText("Case-question contact value"), "123");
    await fireEvent.press(screen.getByText("Save Doctor Preferences"));
    expect(screen.getByText("Enter a valid phone number.")).toBeTruthy();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("submits the complete form when validation passes", async () => {
    await render(<DoctorPreferencesScreen />);
    await fireEvent.press(screen.getByText("Save Doctor Preferences"));
    expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "provider-a",
      draft: expect.objectContaining({
        occlusionAmount: "0.2",
        proximalContactAmount: "40",
        anatomyOther: "Match the adjacent central",
        caseQuestionContactValue: "doctor@example.com",
      }),
    }));
  });

  it("lets providers clear saved units, anatomy, and contact choices", async () => {
    await render(<DoctorPreferencesScreen />);
    await fireEvent.press(screen.getByLabelText("Clear occlusion unit"));
    await fireEvent.press(screen.getByLabelText("Clear proximal-contact unit"));
    await fireEvent.press(screen.getByLabelText("Clear anatomy preference"));
    await fireEvent.press(screen.getByLabelText("Clear case-question contact method"));
    await fireEvent.press(screen.getByText("Save Doctor Preferences"));

    expect(state.mutate).toHaveBeenCalledWith({
      userId: "provider-a",
      draft: expect.objectContaining({
        occlusionUnit: "",
        proximalContactUnit: "",
        anatomyPreference: "",
        caseQuestionContactMethod: "",
      }),
    });
  });

  it("does not clear local entries when the request fails", async () => {
    setMockFetchHandler(() => new Response(
      JSON.stringify({ message: "Could not save" }),
      { status: 500, headers: { "content-type": "application/json" } },
    ));
    await render(<DoctorPreferencesScreen />);
    await fireEvent.changeText(screen.getByLabelText("Occlusion amount"), "0.35");
    await expect(state.mutationOptions?.mutationFn({
      userId: "provider-a",
      draft: {
        ...state.data,
        occlusionAmount: "0.35",
        proximalContactAmount: "40",
      },
    })).rejects.toBeTruthy();
    expect(screen.getByDisplayValue("0.35")).toBeTruthy();
  });

  it("does not overwrite edits when preferences refetch", async () => {
    const view = await render(<DoctorPreferencesScreen />);
    await fireEvent.changeText(screen.getByLabelText("Occlusion amount"), "0.35");
    state.data = { ...state.data, occlusionAmount: 0.5 };
    await view.rerender(<DoctorPreferencesScreen />);
    expect(screen.getByDisplayValue("0.35")).toBeTruthy();
  });

  it("hydrates the newly signed-in user's values instead of showing the prior account", async () => {
    const view = await render(<DoctorPreferencesScreen />);
    expect(screen.getByDisplayValue("doctor@example.com")).toBeTruthy();

    state.currentUserId = "provider-b";
    state.data = {
      ...state.data,
      occlusionAmount: 0.5,
      caseQuestionContactValue: "second@example.com",
    };
    await view.rerender(<DoctorPreferencesScreen />);

    expect(screen.getByDisplayValue("0.5")).toBeTruthy();
    expect(screen.getByDisplayValue("second@example.com")).toBeTruthy();
    expect(screen.queryByDisplayValue("doctor@example.com")).toBeNull();
  });

  it("ignores a late save response from the previously signed-in account", async () => {
    const view = await render(<DoctorPreferencesScreen />);
    const priorMutation = state.mutationOptions;

    state.currentUserId = "provider-b";
    state.data = {
      ...state.data,
      occlusionAmount: 0.5,
      caseQuestionContactValue: "second@example.com",
    };
    await view.rerender(<DoctorPreferencesScreen />);
    expect(screen.getByDisplayValue("second@example.com")).toBeTruthy();

    await act(() => {
      priorMutation?.onSuccess?.(
        { ...INITIAL_DATA, caseQuestionContactValue: "doctor@example.com" },
        { draft: {}, userId: "provider-a" },
      );
    });

    expect(screen.getByDisplayValue("second@example.com")).toBeTruthy();
    expect(screen.queryByDisplayValue("doctor@example.com")).toBeNull();
  });
});