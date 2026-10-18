import React from "react";
import { cleanup, render } from "@testing-library/react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";
import MoreMenuScreen from "../(tabs)/more";

vi.mock("@workspace/api-client-react", () => ({
  useGetAiMemoryCandidates: () => ({ data: { data: [] } }),
  getGetAiMemoryCandidatesQueryKey: () => ["ai-memory-candidates"],
}));

vi.mock("@/lib/duplicate-doctors", () => ({
  useDuplicateDoctorClusters: () => ({ totalGroups: 0 }),
}));

vi.mock("@/lib/messenger", () => ({
  useMessengerUnreadCount: () => ({ total: 0 }),
}));

vi.mock("@/lib/in-app-notifications", () => ({
  useInAppNotifications: () => ({ unreadCount: 0 }),
}));

afterEach(() => {
  cleanup();
  resetMockAppState();
});

function membership(role: string, status = "active") {
  return {
    organizationId: "lab-1",
    role,
    status,
    organization: { id: "lab-1", type: "lab" },
  };
}

function providerMembership(role: string, status = "active") {
  return {
    organizationId: "provider-1",
    role,
    status,
    organization: { id: "provider-1", type: "provider" },
  };
}

describe("More menu issue reporting", () => {
  it.each(["owner", "admin"])("shows Report an Issue for an active %s", async (role) => {
    setMockAppState({ meMemberships: [membership(role)] });
    expect((await render(<MoreMenuScreen />)).getByText("Report an Issue")).toBeTruthy();
  });

  it.each(["owner", "admin"])("shows Report an Issue for an active provider %s", async (role) => {
    setMockAppState({ meMemberships: [providerMembership(role)] });
    expect((await render(<MoreMenuScreen />)).getByText("Report an Issue")).toBeTruthy();
  });

  it.each([
    ["billing", "active"],
    ["user", "active"],
    ["admin", "inactive"],
  ])("hides Report an Issue for role %s with status %s", async (role, status) => {
    setMockAppState({ meMemberships: [membership(role, status)] });
    expect((await render(<MoreMenuScreen />)).queryByText("Report an Issue")).toBeNull();
  });
});