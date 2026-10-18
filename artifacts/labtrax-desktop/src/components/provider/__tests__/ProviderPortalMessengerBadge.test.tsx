/** @vitest-environment jsdom */
// Provider portal sidebar → the Message My Lab unread badge.
//
// Opening the section clears the badge, because the server watermark only
// moves once the conversation renders and marks the newest message read. The
// count keeps being polled behind the open section, so this covers the window
// the clear-on-entry rule alone leaves open: a poll landing while the provider
// is reading must not put the badge back, on screen or on the way out.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ProviderPortalLayout } from "../../ProviderPortalLayout";
import { makeAuthWrapper } from "../../../__tests__/test-utils";
import type { SessionUser } from "@/lib/api";

/** Unread total the server reports on the next poll. */
const server = { unreadTotal: 0 };

const apiFetchMock = vi.fn((path: string, _options?: unknown) => {
  if (path === "/provider/organizations") {
    return Promise.resolve([{ id: "practice-1", name: "Practice One" }]);
  }
  if (path === "/provider/selection") {
    return Promise.resolve({ providerOrganizationId: "practice-1" });
  }
  if (path === "/notifications") return Promise.resolve([]);
  if (path === "/provider-messenger/unread-count") {
    return Promise.resolve({ total: server.unreadTotal });
  }
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

/** Matches the layout's own messenger poll interval. */
const MESSENGER_POLL_INTERVAL_MS = 30_000;

/** Let the mount-time requests resolve. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Run one messenger poll tick and let its response land. */
async function pollUnreadCount(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MESSENGER_POLL_INTERVAL_MS);
  });
}

function badge(): HTMLElement | null {
  return screen.queryByLabelText(/unread message/);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  server.unreadTotal = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("provider portal messenger badge", () => {
  it("stays cleared for a count that arrives while the provider is reading", async () => {
    server.unreadTotal = 3;
    const Wrapper = makeAuthWrapper("/", { user: USER, status: "authed" });
    render(<ProviderPortalLayout cases={[]} casesError={null} />, { wrapper: Wrapper });
    await settle();

    expect(badge()).toHaveTextContent("3");

    fireEvent.click(screen.getByRole("button", { name: /Message My Lab/ }));
    expect(badge()).toBeNull();

    // A poll lands while the conversation is open.
    server.unreadTotal = 5;
    await pollUnreadCount();
    expect(badge()).toBeNull();

    // Leaving does not resurrect it: that count was already in front of them.
    fireEvent.click(screen.getByRole("button", { name: /Dashboard/ }));
    expect(badge()).toBeNull();

    // Only a count fetched after they left is new mail.
    server.unreadTotal = 2;
    await pollUnreadCount();
    expect(badge()).toHaveTextContent("2");
  });
});
