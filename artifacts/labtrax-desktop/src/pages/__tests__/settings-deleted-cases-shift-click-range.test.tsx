/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// Task #2798: shift-click range selection on the Settings → Deleted Cases
// panel (same semantics as the Cases list, Task #2796). After a normal
// checkbox click sets the anchor, shift-clicking another row selects every
// deleted case between them in the visible order.

const ME_RESPONSE = {
  user: { id: "u1", username: "admin", role: "admin", userType: "lab" },
  memberships: [
    {
      id: "m1",
      organizationId: "lab-1",
      role: "admin",
      status: "active",
      organization: { id: "lab-1", type: "lab", name: "Lab One" },
    },
  ],
};

const DELETED_CASES = [1, 2, 3, 4, 5].map((n) => ({
  id: `case-${n}`,
  caseNumber: `26-${n}`,
  patientFirstName: "Pat",
  patientLastName: `Lastname${n}`,
  doctorName: "Dr. Alpha",
  deletedAt: `2026-06-${String(10 + n).padStart(2, "0")}T10:00:00.000Z`,
  createdAt: "2026-06-01T10:00:00.000Z",
}));

beforeEach(() => {
  window.history.pushState({}, "", "/?tab=deleted-cases");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (path.endsWith("/auth/me")) return json(ME_RESPONSE);
      if (path.endsWith("/cases/deleted"))
        return json({ cases: DELETED_CASES });
      return json({});
    }),
  );
});

afterEach(() => {
  window.history.pushState({}, "", "/");
  localStorage.clear();
  sessionStorage.clear();
});

async function renderDeletedCasesPanel() {
  const Wrapper = makeAuthWrapper("/settings", {
    user: {
      id: "u1",
      username: "admin",
      role: "admin",
      userType: "lab",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <SettingsPage />
    </Wrapper>,
  );
  await screen.findByLabelText("Select case 26-1");
}

function checkbox(caseNumber: string): HTMLInputElement {
  return screen.getByLabelText(
    `Select case ${caseNumber}`,
  ) as HTMLInputElement;
}

function selectedNumbers(): string[] {
  return ["26-1", "26-2", "26-3", "26-4", "26-5"].filter(
    (n) => checkbox(n).checked,
  );
}

describe("Deleted Cases panel shift-click range selection", () => {
  it("selects the range downward (anchor above the shift-clicked row)", async () => {
    await renderDeletedCasesPanel();

    fireEvent.click(checkbox("26-1"));
    fireEvent.click(checkbox("26-4"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["26-1", "26-2", "26-3", "26-4"]);
  });

  it("selects the range upward (anchor below the shift-clicked row)", async () => {
    await renderDeletedCasesPanel();

    fireEvent.click(checkbox("26-4"));
    fireEvent.click(checkbox("26-2"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["26-2", "26-3", "26-4"]);
  });

  it("adds the range to previously selected cases outside it", async () => {
    await renderDeletedCasesPanel();

    fireEvent.click(checkbox("26-5"));
    fireEvent.click(checkbox("26-1"));
    fireEvent.click(checkbox("26-3"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["26-1", "26-2", "26-3", "26-5"]);
  });

  it("treats a shift-click with no anchor as a single toggle and sets the anchor", async () => {
    await renderDeletedCasesPanel();

    // No prior click: shift-click toggles only the clicked row…
    fireEvent.click(checkbox("26-3"), { shiftKey: true });
    expect(selectedNumbers()).toEqual(["26-3"]);

    // …and it becomes the anchor for the next shift-click.
    fireEvent.click(checkbox("26-5"), { shiftKey: true });
    expect(selectedNumbers()).toEqual(["26-3", "26-4", "26-5"]);
  });

  it("keeps normal single toggling and select-all behavior intact", async () => {
    await renderDeletedCasesPanel();

    fireEvent.click(checkbox("26-3"));
    expect(checkbox("26-3").checked).toBe(true);
    fireEvent.click(checkbox("26-3"));
    expect(checkbox("26-3").checked).toBe(false);

    const selectAll = screen.getByLabelText("Select all") as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(selectedNumbers()).toEqual(["26-1", "26-2", "26-3", "26-4", "26-5"]);
    fireEvent.click(selectAll);
    expect(selectedNumbers()).toEqual([]);
  });
});
