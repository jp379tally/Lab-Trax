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

  it("gates an administrator-only panel opened from a direct query string", () => {
    window.history.pushState({}, "", "/settings?tab=backup");
    const Wrapper = makeAuthWrapper(
      "/settings?tab=backup",
      {
        user: ADMIN_USER as any,
        status: "authed",
        restoreStatus: "ok",
        restoreNoticeDismissed: true,
      },
      { adminSettingsPin: null },
    );
    render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );

    expect(screen.getByTestId("admin-settings-pin-gate")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-summary")).not.toBeInTheDocument();
  });

  it("renders the lab/environment name heading above Lab team status", () => {
    const Wrapper = makeAuthWrapper("/settings", {
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

describe("SettingsPage grouped left nav", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  function renderSettings(search = "") {
    if (search) window.history.pushState({}, "", search);
    const Wrapper = makeAuthWrapper(`/settings${search}`, {
      user: ADMIN_USER as any,
      status: "authed",
      restoreStatus: "ok",
      restoreNoticeDismissed: true,
    });
    return render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );
  }

  const navButton = (name: RegExp) => screen.queryByRole("button", { name });

  it("expands Profile by default and keeps Lab Preferences collapsed", () => {
    renderSettings();
    // Profile is the landing section, so its children are revealed.
    expect(navButton(/^Password$/)).toBeInTheDocument();
    expect(navButton(/^Active sessions$/)).toBeInTheDocument();
    expect(navButton(/^Notifications$/)).toBeInTheDocument();
    // The sibling group stays collapsed until it (or a child) is selected.
    expect(navButton(/^Lab Preferences$/)).toBeInTheDocument();
    expect(navButton(/^Backup/)).not.toBeInTheDocument();
    expect(navButton(/^Templates$/)).not.toBeInTheDocument();
  });

  it("opens a deep-linked child with its ancestor groups expanded", () => {
    renderSettings("?tab=closed-days");
    // Ancestor group + its siblings are visible …
    expect(navButton(/^Lab Preferences$/)).toBeInTheDocument();
    expect(navButton(/^Closed Days$/)).toBeInTheDocument();
    expect(navButton(/^Templates$/)).toBeInTheDocument();
    // … and the two-level-deep Templates children stay collapsed.
    expect(navButton(/^Invoice layout$/)).not.toBeInTheDocument();
  });

  it("expands Templates two levels deep for a template deep link", () => {
    renderSettings("?tab=statement-email");
    expect(navButton(/^Lab Preferences$/)).toBeInTheDocument();
    expect(navButton(/^Templates$/)).toBeInTheDocument();
    expect(navButton(/^Invoice layout$/)).toBeInTheDocument();
    expect(navButton(/^Statement email$/)).toBeInTheDocument();
  });

  it("no longer offers a Desktop app section", () => {
    renderSettings();
    expect(navButton(/^Desktop app$/)).not.toBeInTheDocument();
  });
});
