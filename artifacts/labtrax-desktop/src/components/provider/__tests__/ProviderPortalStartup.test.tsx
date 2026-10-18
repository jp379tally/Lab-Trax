/** @vitest-environment jsdom */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProviderCasesPage from "@/pages/provider-cases";
import { makeAuthWrapper } from "@/__tests__/test-utils";
import type { SessionUser } from "@/lib/api";

const mocks = vi.hoisted(() => ({ api: vi.fn(), boundary: vi.fn(), logout: vi.fn() }));
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mocks.api(...args),
  setProviderOrganizationId: mocks.boundary,
}));
vi.mock("../ProviderDashboard", () => ({ ProviderDashboard: ({ cases, error }: { cases: unknown; error: string }) => <div>Dashboard content: {cases ? JSON.stringify(cases) : "Loading cases"}{error}</div> }));
vi.mock("../ProviderBilling", () => ({ ProviderBilling: () => <div>Billing content</div> }));
vi.mock("../ProviderMessageLab", () => ({ ProviderMessageLab: () => <div>Message content</div> }));
vi.mock("../ProviderStats", () => ({ ProviderStats: () => <div>Stats content</div> }));
vi.mock("../ProviderMyAccount", () => ({ ProviderMyAccount: () => <div>Account content</div> }));

const north = { id: "north", name: "North", role: "owner" };
const south = { id: "south", name: "South", role: "owner" };
let organizations = [north];
let listError = false;
let selection: (id: string) => Promise<unknown> = async () => ({});
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function open() {
  const wrapper = makeAuthWrapper("/settings", { status: "authed",
    user: { id: "provider", username: "provider", userType: "provider" } as SessionUser,
    logout: mocks.logout });
  return render(<ProviderCasesPage />, { wrapper });
}
beforeEach(() => {
  localStorage.clear();
  organizations = [north];
  listError = false;
  selection = async () => ({});
  vi.clearAllMocks();
  mocks.api.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/provider/organizations") return listError ? Promise.reject(new Error("Offline")) : Promise.resolve(organizations);
    if (path === "/provider/selection") return selection(JSON.parse(String(init?.body)).providerOrganizationId);
    if (path === "/auth/me") return Promise.resolve({ memberships: [] });
    if (path === "/cases/provider") return Promise.resolve([]);
    if (path === "/notifications") return Promise.resolve([]);
    if (path.includes("unread-count")) return Promise.resolve({ total: 0 });
    return Promise.resolve({});
  });
});

describe("fresh provider startup", () => {
  it("uses one list/selection bootstrap and loads cases only after confirmation", async () => {
    const gate = deferred();
    selection = () => gate.promise;
    open();
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/provider/selection", expect.anything()));
    expect(mocks.api.mock.calls.filter(([url]) => url === "/cases/provider")).toHaveLength(0);
    await act(async () => gate.resolve());
    await screen.findByText("Dashboard content: []");
    expect(mocks.api.mock.calls.filter(([url]) => url === "/provider/organizations")).toHaveLength(1);
    expect(mocks.api.mock.calls.filter(([url]) => url === "/provider/selection")).toHaveLength(1);
    expect(mocks.boundary).toHaveBeenLastCalledWith(north.id);
  });
  it("keeps every navigation/header action meaningful without an approved practice", async () => {
    organizations = [];
    open();
    await screen.findByText("No active practice yet");
    for (const label of ["View and Pay My Bill", "Message My Lab", "Stats", "Dashboard"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      expect(screen.getByText("No active practice yet")).toBeInTheDocument();
      expect(screen.getAllByText(label).length).toBeGreaterThan(1);
    }
    fireEvent.click(screen.getByRole("button", { name: /My Account/ }));
    expect(screen.getByText("Account content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Notification Settings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByText("No new alerts");
    fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    expect(screen.queryByText("No new alerts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mocks.logout).toHaveBeenCalled();
    expect(mocks.api.mock.calls.filter(([url]) => url === "/cases/provider")).toHaveLength(0);
  });
  it("recovers failed lists through retry without needing a relaunch", async () => {
    listError = true;
    open();
    await screen.findByRole("button", { name: "Try again" });
    listError = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Dashboard content: []");
  });
  it("recovers a failed initial selection and never publishes it before confirmation", async () => {
    selection = async () => { throw new Error("Selection refused"); };
    open();
    await screen.findByRole("button", { name: "Try again" });
    expect(mocks.boundary).not.toHaveBeenCalledWith(north.id);
    selection = async () => ({});
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Dashboard content: []");
  });
  it("restores only a practice still in the active authorized list", async () => {
    organizations = [north, south];
    localStorage.setItem("labtrax_provider_practice_v1:provider", south.id);
    open();
    await screen.findByText("Dashboard content: []");
    expect(mocks.boundary).toHaveBeenLastCalledWith(south.id);
  });
  it("drops a revoked persisted selection and requires a new selection", async () => {
    organizations = [north, south];
    localStorage.setItem("labtrax_provider_practice_v1:provider", "removed");
    open();
    await screen.findByText("Select a practice above to enter its provider portal.");
    expect(localStorage.getItem("labtrax_provider_practice_v1:provider")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Active practice" }), { target: { value: south.id } });
    await screen.findByText("Dashboard content: []");
  });
  it("ignores an outgoing case request failure after a practice switch", async () => {
    organizations = [north, south];
    localStorage.setItem("labtrax_provider_practice_v1:provider", north.id);
    const old = deferred();
    const defaultHandler = mocks.api.getMockImplementation()!;
    let caseCalls = 0;
    mocks.api.mockImplementation((path, init) => path === "/cases/provider" && caseCalls++ === 0 ? old.promise : defaultHandler(path, init));
    open();
    await screen.findByText(/Loading cases/);
    fireEvent.change(screen.getByRole("combobox", { name: "Active practice" }), { target: { value: south.id } });
    await screen.findByText("Dashboard content: []");
    await act(async () => old.reject(new Error("Stale north failure")));
    expect(screen.queryByText(/Stale north failure/)).toBeNull();
  });
  it("serializes rapid switches and ignores superseded selection failures", async () => {
    organizations = [north, south];
    const old = deferred();
    selection = (id) => id === north.id ? old.promise : Promise.resolve({});
    open();
    await screen.findByRole("combobox", { name: "Active practice" });
    fireEvent.change(screen.getByRole("combobox", { name: "Active practice" }), { target: { value: north.id } });
    fireEvent.change(screen.getByRole("combobox", { name: "Active practice" }), { target: { value: south.id } });
    await act(async () => old.reject(new Error("Superseded")));
    await screen.findByText("Dashboard content: []");
    expect(mocks.boundary).toHaveBeenLastCalledWith(south.id);
    expect(screen.queryByText(/Superseded/)).toBeNull();
  });
});
