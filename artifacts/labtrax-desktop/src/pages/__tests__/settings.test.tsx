/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import type { ReactNode } from "react";
import { makeWrapper } from "../../__tests__/test-utils";

vi.mock("@/lib/auth-context", async () => {
  return {
    AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useAuth: () => ({
      user: {
        id: "user-1",
        username: "admin",
        firstName: "Ada",
        lastName: "Lovelace",
        role: "admin",
      },
      status: "authed" as const,
      restoreStatus: "ok" as const,
      restoreNoticeDismissed: true,
      acknowledgeRestoreNotice: () => {},
      login: async () => {},
      logout: async () => {},
      refresh: async () => {},
    }),
  };
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

describe("SettingsPage smoke render", () => {
  it("renders the settings shell for an admin without throwing", () => {
    const Wrapper = makeWrapper("/settings");
    render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );
    // Sidebar nav labels — if the settings page itself bails out the user
    // sees a blank screen with no way to recover.
    expect(screen.getByText(/Admin Settings/i)).toBeInTheDocument();
    expect(screen.getAllByText("Profile").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Password").length).toBeGreaterThan(0);
  });
});
