/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
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

describe("SettingsPage navigation guards", () => {
  afterEach(() => {
    // Reset any URL changes made during tests so state doesn't leak.
    window.history.pushState({}, "", "/");
  });

  it("does NOT render a 'Users' nav entry for an admin", () => {
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
    // The "Users" nav button must be absent — it was intentionally hidden in
    // favour of Customer Center and Profile → Lab team status.
    const navButtons = screen.queryAllByRole("button", { name: /^Users$/i });
    expect(navButtons).toHaveLength(0);
  });

  it("lands on the Profile section when ?tab=users is in the URL", () => {
    // Push ?tab=users into jsdom's location before rendering so readInitialTab()
    // can read it.  It must fall back to "profile" because "users" is omitted
    // from VALID_TAB_KEYS.
    window.history.pushState({}, "", "?tab=users");

    const Wrapper = makeAuthWrapper("/settings?tab=users", {
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

    // The Profile panel heading should be visible (active tab = profile).
    expect(screen.getByText(/Lab team status/i)).toBeInTheDocument();
  });

  it("renders the lab/environment name heading above Lab team status", () => {
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

    // The heading reads "<labName|practiceName|Lab> Environment".
    // With no teamQuery data and no practiceName on the mock user it
    // falls back to "Lab Environment".
    expect(screen.getByText(/Environment/i)).toBeInTheDocument();

    // "Lab team status" must appear directly below it.
    expect(screen.getByText(/Lab team status/i)).toBeInTheDocument();

    // Verify DOM order: the environment heading comes before "Lab team status".
    const envHeading = screen.getByText(/Environment/i);
    const teamStatusHeading = screen.getByText(/Lab team status/i);
    expect(
      envHeading.compareDocumentPosition(teamStatusHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
