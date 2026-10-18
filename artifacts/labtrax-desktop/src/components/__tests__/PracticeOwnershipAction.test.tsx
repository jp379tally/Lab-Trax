/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PracticeOwnershipAction } from "../PracticeOwnershipAction";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
const member = (id: string, type: string, role: string, status = "active") => ({
  organizationId: id, role, status, organization: { id, type, name: id },
});
beforeEach(() => mocks.api.mockReset());
function mount(memberships: ReturnType<typeof member>[]) {
  // A partner lab may be the hydrated user's primary membership.
  mocks.api.mockResolvedValue({ user: { role: "user", membershipRole: "user", practiceOrganizationId: "partner-lab" }, memberships });
  const onTransfer = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PracticeOwnershipAction preferredOrganizationId="partner-lab" onTransfer={onTransfer} />
    </QueryClientProvider>,
  );
  return { onTransfer, qc };
}
describe("practice ownership independent of lab-first profiles", () => {
  it("offers direct practice ownership even when the primary lab membership is User", async () => {
    const { onTransfer: transfer } = mount([member("partner-lab", "lab", "user"), member("my-practice", "provider", "owner")]);
    fireEvent.click(await screen.findByRole("button", { name: "Transfer practice ownership…" }));
    expect(transfer).toHaveBeenCalledWith("my-practice");
  });
  it("lets an Owner choose between directly owned practices, not lab memberships or client records", async () => {
    const { onTransfer: transfer } = mount([
      member("partner-lab", "lab", "owner"), member("first-practice", "provider", "owner"),
      member("second-practice", "provider", "owner"), member("client-practice", "provider", "admin"),
      member("suspended-practice", "provider", "owner", "suspended"),
    ]);
    const select = await screen.findByLabelText("Practice for ownership transfer");
    expect(screen.queryByRole("option", { name: "partner-lab" })).toBeNull();
    expect(screen.queryByRole("option", { name: "client-practice" })).toBeNull();
    expect(screen.queryByRole("option", { name: "suspended-practice" })).toBeNull();
    fireEvent.change(select, { target: { value: "second-practice" } });
    fireEvent.click(screen.getByRole("button", { name: "Transfer practice ownership…" }));
    expect(transfer).toHaveBeenCalledWith("second-practice");
  });
  it("does not offer practice ownership based only on lab ownership", async () => {
    const { qc } = mount([member("partner-lab", "lab", "owner"), member("client-practice", "provider", "admin")]);
    await waitFor(() => expect(qc.getQueryData(["auth", "me"])).toBeDefined());
    expect(screen.queryByRole("button", { name: "Transfer practice ownership…" })).toBeNull();
  });
});
