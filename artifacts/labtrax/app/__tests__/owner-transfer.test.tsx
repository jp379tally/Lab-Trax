import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Alert, View } from "react-native";
import { act, cleanup, render, fireEvent, waitFor } from "@testing-library/react-native/pure";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OwnerDangerZoneScreen from "../settings/owner/danger-zone";
import OwnerSettingsLayout from "../settings/owner/_layout";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn(), replace: vi.fn(), role: "owner", selectedOrgId: "practice", transferOnly: "1", screen: "danger-zone" }));
vi.mock("@tanstack/react-query", async (original) => await original<typeof import("@tanstack/react-query")>());
vi.mock("@/lib/query-client", () => ({ resilientFetch: mocks.fetch }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ refreshUsers: mocks.refresh }) }));
// Exercise the layout's boundary selection independently of the Creator PIN
// flow, which has its own access-control suite.
vi.mock("@/components/creator/CreatorGate", () => ({
  CreatorGate: ({ children }: { children: React.ReactNode }) => (
    <View testID="private-creator-boundary">{children}</View>
  ),
}));
vi.mock("expo-router", () => ({
  router: { back: vi.fn(), replace: mocks.replace },
  useLocalSearchParams: () => ({ organizationId: "practice", transferOnly: "1" }),
  useGlobalSearchParams: () => ({ organizationId: mocks.selectedOrgId, transferOnly: mocks.transferOnly }),
  useSegments: () => ["settings", "owner", mocks.screen],
  Stack: () => null,
}));
vi.mock("@/lib/auth-me", () => ({
  useMe: () => ({ isSuccess: true, data: { user: { id: "creator" }, memberships: [{ organizationId: "practice", role: mocks.role, status: "active" }] } }),
  primaryOwnerLabOrgId: () => null,
  canOwnAnyLab: () => false,
}));
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "owner";
  mocks.selectedOrgId = "practice";
  mocks.transferOnly = "1";
  mocks.screen = "danger-zone";
  mocks.refresh.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/owner/lab-profile")) return response({ name: "Standalone Practice" });
    if (path.startsWith("/api/owner/team")) return response([
      { userId: "creator", username: "Creator", role: "owner", status: "active" },
      { userId: "recipient", username: "Recipient", role: "user", status: "active" },
      { userId: "suspended", username: "Suspended", role: "user", status: "suspended" },
    ]);
    if (path === "/api/owner/transfer-ownership") return response({ transferred: true });
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(async () => { await cleanup(); });

async function confirm(ui: Awaited<ReturnType<typeof render>>) {
  // Mutation completion and its batched query notifications both belong
  // inside the async renderer boundary, not just the initial button press.
  await act(async () => {
    await fireEvent.press(ui.getByText("Confirm Transfer"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function prepare() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const ui = await render(<QueryClientProvider client={qc}><OwnerDangerZoneScreen /></QueryClientProvider>);
  await fireEvent.press(ui.getByText("Transfer Ownership…"));
  await waitFor(() => expect(ui.getByText("Recipient")).toBeTruthy());
  expect(ui.queryByText("Suspended")).toBeNull();
  expect(ui.queryByText("Delete Lab…")).toBeNull();
  await fireEvent.press(ui.getByText("Recipient"));
  await fireEvent.changeText(ui.getByLabelText("Organization name confirmation"), "Standalone Practice");
  return { ui, qc };
}
describe("mobile confirmed ownership handoff", () => {
  it("performs a single scoped operation, refreshing roles without reporting a committed transfer as failed", async () => {
    const { ui, qc } = await prepare();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    mocks.refresh.mockRejectedValueOnce(new Error("Offline refresh"));
    await confirm(ui);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    const writes = mocks.fetch.mock.calls.filter(([path]) => path === "/api/owner/transfer-ownership");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1].body)).toEqual({ organizationId: "practice", newOwnerUserId: "recipient", confirmationPhrase: "Standalone Practice" });
    for (const key of ["auth-me", "owner", "lab-team"]) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    expect(Alert.alert).toHaveBeenCalledWith("Transferred", "Ownership has been transferred.", expect.any(Array));
    expect(Alert.alert).not.toHaveBeenCalledWith("Error", "Offline refresh");
  });
  it("shows a rejection and leaves the selected target and confirmed roles unchanged", async () => {
    const { ui } = await prepare();
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Recipient is no longer an active member." }), { status: 400 }));
    await confirm(ui);
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Error", "Recipient is no longer an active member."));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(ui.getByLabelText("Organization name confirmation").props.value).toBe("Standalone Practice");
    expect(ui.getByText("Recipient")).toBeTruthy();
    expect(mocks.role).toBe("owner");
  });
  it("requires direct ownership of the selected practice", async () => {
    mocks.role = "admin";
    const qc = new QueryClient();
    const ui = await render(<QueryClientProvider client={qc}><OwnerDangerZoneScreen /></QueryClientProvider>);
    expect(ui.getByText("Owner access required.")).toBeTruthy();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("allows a standalone Owner through the parent layout only for their scoped transfer screen", async () => {
    const ui = await render(<OwnerSettingsLayout />);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(ui.queryByTestId("private-creator-boundary")).toBeNull();
  });
  it.each(["other-organization", "admin", "lab-management", "delete-screen"])("does not widen standalone Owner access (%s)", async (rejection) => {
    if (rejection === "other-organization") mocks.selectedOrgId = "foreign-practice";
    if (rejection === "admin") mocks.role = "admin";
    if (rejection === "lab-management") mocks.screen = "lab-profile";
    if (rejection === "delete-screen") mocks.transferOnly = "0";
    const ui = await render(<OwnerSettingsLayout />);
    expect(ui.getByTestId("private-creator-boundary")).toBeTruthy();
    expect(mocks.replace).toHaveBeenCalledWith(
      rejection === "other-organization" || rejection === "admin" ? "/account" : "/settings",
    );
  });
});
