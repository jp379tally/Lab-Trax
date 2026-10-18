import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const state = vi.hoisted(() => ({
  eligible: true,
  query: {
    data: {
      preferences: {
        inAppNewCase: true,
        inAppTeammateMessage: true,
        inAppDoctorPracticeMessage: true,
        inAppExceptionCase: true,
        inAppRushCase: true,
      },
      hasActiveOwnerOrAdminLabMembership: true,
    },
    isLoading: false,
    error: null,
  },
  mutationOptions: null as any,
  queryOptions: null as any,
  mutate: vi.fn(),
  setQueryData: vi.fn(),
  resilientFetch: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options) => {
    state.queryOptions = options;
    return {
      ...state.query,
      data: {
        ...state.query.data,
        hasActiveOwnerOrAdminLabMembership: state.eligible,
      },
    };
  }),
  useMutation: vi.fn((options) => {
    state.mutationOptions = options;
    return { mutate: state.mutate, error: null, isPending: false };
  }),
  useQueryClient: vi.fn(() => ({ setQueryData: state.setQueryData })),
}));

vi.mock("@/lib/query-client", () => ({
  resilientFetch: state.resilientFetch,
}));

vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({
    colors: {
      text: "#111827",
      textSecondary: "#6B7280",
      tint: "#007AFF",
      border: "#E5E7EB",
      surface: "#FFFFFF",
      background: "#F3F4F6",
      error: "#EF4444",
    },
  }),
}));

import NotificationsScreen from "../settings/notifications";

describe("NotificationsScreen — in-app controls", () => {
  beforeEach(() => {
    state.eligible = true;
    state.mutate.mockReset();
    state.setQueryData.mockReset();
    state.resilientFetch.mockReset();
    state.query.data.preferences.inAppNewCase = true;
  });

  it("shows all five in-app categories for an eligible lab owner or admin", async () => {
    state.eligible = true;

    await render(<NotificationsScreen />);

    expect(screen.getByText("IN-APP NOTIFICATIONS")).toBeTruthy();
    expect(screen.getByText("New cases")).toBeTruthy();
    expect(screen.getByText("Teammate messages")).toBeTruthy();
    expect(screen.getByText("Doctor and practice messages")).toBeTruthy();
    expect(screen.getByText("Exception cases")).toBeTruthy();
    expect(screen.getByText("Rush cases")).toBeTruthy();
  });

  it("hides in-app controls for users without an eligible lab membership", async () => {
    state.eligible = false;

    await render(<NotificationsScreen />);

    expect(screen.queryByText("IN-APP NOTIFICATIONS")).toBeNull();
    expect(screen.getByText("EMAIL")).toBeTruthy();
  });

  it("reloads the saved disabled New cases preference from the API", async () => {
    state.resilientFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        preferences: { inAppNewCase: false },
        hasActiveOwnerOrAdminLabMembership: true,
      }),
    });
    await render(<NotificationsScreen />);

    const loaded = await state.queryOptions.queryFn();

    expect(state.resilientFetch).toHaveBeenCalledWith(
      "/api/auth/notification-preferences",
    );
    expect(loaded.preferences.inAppNewCase).toBe(false);
  });

  it("optimistically disables New cases and rolls it back when saving fails", async () => {
    const rendered = await render(<NotificationsScreen />);
    await waitFor(() =>
      expect(state.mutationOptions?.scope).toEqual({
        id: "notification-preferences",
      }),
    );
    const newCasesLabel = rendered.getByText("New cases");
    let cursor: any = newCasesLabel;
    let newCasesSwitch: any;
    for (let depth = 0; depth < 6 && !newCasesSwitch; depth += 1) {
      cursor = cursor.parent;
      newCasesSwitch = cursor?.children?.find(
        (child: any) => child.props?.accessibilityRole === "switch",
      );
    }
    expect(newCasesSwitch).toBeTruthy();

    await fireEvent(newCasesSwitch!, "valueChange", false);

    expect(state.mutate).toHaveBeenCalledWith({
      patch: { inAppNewCase: false },
      key: "inAppNewCase",
      previous: true,
    });

    state.mutationOptions.onError(new Error("save failed"), {
      patch: { inAppNewCase: false },
      key: "inAppNewCase",
      previous: true,
    });
    const rollbackUpdater =
      state.setQueryData.mock.calls[state.setQueryData.mock.calls.length - 1]![1];
    expect(
      rollbackUpdater({
        preferences: { inAppNewCase: false, inAppRushCase: true },
      }).preferences.inAppNewCase,
    ).toBe(true);
  });

  it("merges only the acknowledged switch after a successful save", async () => {
    await render(<NotificationsScreen />);
    state.mutationOptions.onSuccess(
      {
        preferences: {
          inAppNewCase: false,
          inAppRushCase: false,
        },
      },
      {
        patch: { inAppNewCase: false },
        key: "inAppNewCase",
        previous: true,
      },
    );
    const successUpdater =
      state.setQueryData.mock.calls[state.setQueryData.mock.calls.length - 1]![1];
    expect(
      successUpdater({
        preferences: { inAppNewCase: true, inAppRushCase: true },
      }).preferences,
    ).toEqual({
      inAppNewCase: false,
      inAppRushCase: true,
    });
  });
});