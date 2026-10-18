/** @vitest-environment jsdom */
/**
 * Settings → Closed Days panel.
 *
 * Asserts:
 *   1. The "Closed Days" nav entry is visible for admins.
 *   2. Clicking it renders the add-date form and the US Federal Holidays list.
 *   3. Existing custom closed days are displayed with their notes.
 *   4. A custom day can be deleted (the DELETE endpoint is called).
 *   5. Adding a new custom day calls POST with the right body.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const LAB_ORG_ID = "org-lab-1";

const ADMIN_USER = {
  id: "u1",
  username: "labadmin",
  firstName: "Lab",
  lastName: "Admin",
  role: "admin",
};

const ME_RESPONSE = {
  user: ADMIN_USER,
  memberships: [
    {
      id: "mem-1",
      role: "admin",
      status: "active",
      organizationId: LAB_ORG_ID,
      organization: { id: LAB_ORG_ID, name: "Apex Dental Lab", type: "lab" },
    },
  ],
};

const CLOSED_DAYS_RESPONSE = {
  closedDays: [
    {
      id: "cd-1",
      date: "2026-07-04",
      note: "Independence Day (custom)",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "cd-2",
      date: "2026-12-24",
      note: "Christmas Eve — lab closed",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

function makeFetchMock(options: {
  onDelete?: (url: string) => void;
  onPost?: (url: string, body: unknown) => void;
} = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "DELETE" && url.includes("closed-days")) {
      options.onDelete?.(url);
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST" && url.includes("closed-days")) {
      options.onPost?.(url, JSON.parse((init?.body as string) ?? "{}"));
      return new Response(
        JSON.stringify({ closedDay: { id: "cd-new", date: "2027-01-02", note: null, createdAt: new Date().toISOString() } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/auth/me")) {
      return new Response(JSON.stringify(ME_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("closed-days")) {
      return new Response(JSON.stringify(CLOSED_DAYS_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ team: [], members: [], items: [], sessions: [], schedules: [], memberships: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

function renderSettings() {
  window.history.pushState({}, "", "?tab=closed-days");
  const Wrapper = makeAuthWrapper("/settings?tab=closed-days", {
    user: ADMIN_USER as NonNullable<Parameters<typeof makeAuthWrapper>[1]>["user"],
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <SettingsPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
  window.history.pushState({}, "", "/");
});

describe("Settings → Closed Days panel", () => {
  it("shows the Closed Days nav entry for an admin", () => {
    vi.stubGlobal("fetch", makeFetchMock());
    renderSettings();
    expect(screen.getByRole("button", { name: /Closed Days/i })).toBeInTheDocument();
  });

  it("renders the add-date form and US Federal Holidays heading", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText(/Add a custom closed day/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/US Federal Holidays/i)).toBeInTheDocument();
  });

  it("lists existing custom closed days with notes", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText(/Christmas Eve — lab closed/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Independence Day \(custom\)/i)).toBeInTheDocument();
  });

  it("calls DELETE when the remove button is clicked on a custom day", async () => {
    const deletedUrls: string[] = [];
    vi.stubGlobal("fetch", makeFetchMock({ onDelete: (url) => deletedUrls.push(url) }));
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText(/Christmas Eve — lab closed/i)).toBeInTheDocument();
    });

    const removeButtons = screen.getAllByTitle(/Remove this closed day/i);
    expect(removeButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(deletedUrls.length).toBe(1);
      expect(deletedUrls[0]).toMatch(/closed-days/);
    });
  });

  it("calls POST with the selected date when the Add button is clicked", async () => {
    const postedBodies: unknown[] = [];
    vi.stubGlobal("fetch", makeFetchMock({ onPost: (_url, body) => postedBodies.push(body) }));
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText(/Add a custom closed day/i)).toBeInTheDocument();
    });

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateInput).not.toBeNull();
    fireEvent.change(dateInput, { target: { value: "2027-01-02" } });

    const addButton = screen.getByRole("button", { name: /Add/i });
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(postedBodies.length).toBe(1);
      expect((postedBodies[0] as { date: string }).date).toBe("2027-01-02");
    });
  });

  it("shows known federal holidays in the read-only list", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText(/US Federal Holidays/i)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Independence Day/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Thanksgiving Day/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Christmas Day/i).length).toBeGreaterThanOrEqual(1);
  });
});
