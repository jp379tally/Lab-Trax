/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const ADMIN_USER = {
  id: "user-1",
  username: "admin",
  firstName: "Ada",
  lastName: "Lovelace",
  role: "admin",
};

describe("SettingsPage smoke render", () => {
  it("renders the settings shell for an admin without throwing", () => {
    const Wrapper = makeAuthWrapper("/settings", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: ADMIN_USER as any,
      status: "authed",
      restoreStatus: "ok",
      restoreNoticeDismissed: true,
    });
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
