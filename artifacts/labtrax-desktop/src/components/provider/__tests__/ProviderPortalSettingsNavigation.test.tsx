/** @vitest-environment jsdom */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProviderPortalLayout } from "../../ProviderPortalLayout";
import { makeAuthWrapper } from "../../../__tests__/test-utils";
import type { SessionUser } from "@/lib/api";

const apiFetchMock = vi.fn((path: string, _options?: unknown) => {
  if (path === "/provider/organizations") {
    return Promise.resolve([{ id: "practice-1", name: "Practice One" }]);
  }
  if (path === "/provider/selection") {
    return Promise.resolve({ providerOrganizationId: "practice-1" });
  }
  if (path === "/notifications") return Promise.resolve([]);
  if (path === "/provider/messenger/unread-count") return Promise.resolve({ count: 0 });
  if (path.includes("email-preferences")) return Promise.resolve({});
  if (path.includes("in-app-preferences")) return Promise.resolve({});
  if (path.includes("doctor-preferences")) return Promise.resolve({
    occlusionAmount: null,
    occlusionUnit: null,
    proximalContactAmount: null,
    proximalContactUnit: null,
    anatomyPreference: null,
    anatomyOther: null,
    caseQuestionContactMethod: null,
    caseQuestionContactValue: null,
  });
  return Promise.resolve({});
});

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, options?: unknown) => apiFetchMock(path, options),
  setProviderOrganizationId: vi.fn(),
}));
vi.mock("../ProviderDashboard", () => ({ ProviderDashboard: () => <div>Dashboard content</div> }));
vi.mock("../ProviderBilling", () => ({ ProviderBilling: () => <div>Billing content</div> }));
vi.mock("../ProviderMessageLab", () => ({ ProviderMessageLab: () => <div>Message content</div> }));
vi.mock("../ProviderStats", () => ({ ProviderStats: () => <div>Stats content</div> }));
vi.mock("../ProviderMyAccount", () => ({ ProviderMyAccount: () => <div>Account content</div> }));

const USER = { id: "provider-1", username: "provider", userType: "provider" } as SessionUser;

beforeEach(() => vi.clearAllMocks());

describe("provider settings navigation", () => {
  it("opens settings from the header gear and omits the sidebar item", async () => {
    const Wrapper = makeAuthWrapper("/", { user: USER, status: "authed" });
    render(<ProviderPortalLayout cases={[]} casesError={null} />, { wrapper: Wrapper });

    expect(screen.queryByRole("button", { name: /^Settings$/ })).toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(await screen.findByText("Notification Settings")).toBeInTheDocument();
    expect(screen.getByText("Doctor Preferences")).toBeInTheDocument();
  });
});