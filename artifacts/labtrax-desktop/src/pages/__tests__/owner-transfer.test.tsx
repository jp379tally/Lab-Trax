/** @vitest-environment jsdom */
import { describe, it, beforeEach, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OwnerPage from "../owner/OwnerPage";

const mocks = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn(), navigate: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { id: "creator" }, refresh: mocks.refresh }) }));
vi.mock("wouter", () => ({
  useLocation: () => ["/owner", mocks.navigate],
  useSearch: () => "transferOnly=1&organizationId=practice",
}));

const me = {
  user: { id: "creator" },
  memberships: [{
    organizationId: "practice", status: "active", role: "owner",
    organization: { id: "practice", type: "provider", name: "Standalone Practice" },
  }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue(undefined);
  mocks.api.mockImplementation(async (path: string) => {
    if (path === "/auth/me") return me;
    if (path.startsWith("/owner/lab-profile")) return { name: "Standalone Practice" };
    if (path.startsWith("/owner/team")) return [
      { userId: "creator", username: "Creator", status: "active", role: "owner" },
      { userId: "recipient", username: "Recipient", status: "active", role: "user" },
      { userId: "suspended", username: "Suspended", status: "suspended", role: "user" },
    ];
    if (path === "/owner/transfer-ownership") return { transferred: true };
    throw new Error(`Unexpected request: ${path}`);
  });
});
async function prepare() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><OwnerPage /></QueryClientProvider>);
  fireEvent.click(await screen.findByText("Transfer Ownership…"));
  await screen.findByRole("option", { name: "Recipient" });
  expect(screen.queryByText("Delete Lab")).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Suspended" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("New Owner"), { target: { value: "recipient" } });
  expect(screen.getByRole("button", { name: "Confirm Transfer" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Organization name confirmation"), { target: { value: "Standalone Practice" } });
  return qc;
}

describe("confirmed standalone-practice ownership transfer", () => {
  it("submits once and refreshes membership, team and navigation even if the user refresh fails", async () => {
    const qc = await prepare();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    mocks.refresh.mockRejectedValueOnce(new Error("Offline refresh"));
    let resolve!: (value: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const confirm = screen.getByRole("button", { name: "Confirm Transfer" });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    resolve({ transferred: true });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    const calls = mocks.api.mock.calls.filter(([path]) => path === "/owner/transfer-ownership");
    expect(calls).toHaveLength(1);
    expect(calls[0][1].method).toBe("POST");
    expect(JSON.parse(calls[0][1].body)).toEqual({ organizationId: "practice", newOwnerUserId: "recipient", confirmationPhrase: "Standalone Practice" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["auth", "me"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["owner"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["lab-team"] });
    expect(mocks.navigate).toHaveBeenCalledWith("/");
    expect(screen.queryByText("Offline refresh")).not.toBeInTheDocument();
  });
  it("keeps confirmed roles and the handoff open on rejection, and shows the server explanation", async () => {
    await prepare();
    mocks.api.mockRejectedValueOnce(new Error("Recipient is no longer an active member."));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Transfer" }));
    expect(await screen.findByText("Recipient is no longer an active member.")).toBeInTheDocument();
    expect(screen.getByLabelText("New Owner")).toHaveValue("recipient");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
