/** @vitest-environment jsdom */
/**
 * Shift-click range selection on the Doctors merge-selection list (same
 * semantics as the Cases list). Each doctor row's select cell is a
 * role="checkbox" element; a shift-click extends the merge picks from the
 * anchor to the clicked row over the visible order. Range extension is
 * restricted to rows in the same lab and preserves prior picks outside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DoctorsPage from "@/pages/doctors";
import type { SessionUser } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const ADMIN_USER = {
  id: "u1",
  username: "admin",
  role: "admin",
  userType: "lab",
} as unknown as SessionUser;

const NAMES = ["Dr Able", "Dr Baker", "Dr Cole", "Dr Dunn", "Dr Ellis"];

// One case per doctor, all in lab-1 / prov-1 so every row is selectable and in
// a single lab. totalCases ties keep them in insertion order (Dr Able first).
const CASES = NAMES.map((name, idx) => ({
  id: `case-${idx + 1}`,
  doctorName: name,
  providerOrganizationId: "prov-1",
  labOrganizationId: "lab-1",
  status: "in_progress",
  priority: "standard",
  totalPrice: "100.00",
  createdAt: `2026-06-0${idx + 1}T10:00:00.000Z`,
}));

const ME = {
  user: ADMIN_USER,
  memberships: [
    {
      organizationId: "lab-1",
      status: "active",
      role: "admin",
      organization: { id: "lab-1", name: "Lab One", type: "lab" },
    },
  ],
};

beforeEach(() => {
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
      if (path.endsWith("/cases")) return json(CASES);
      if (path.endsWith("/invoices")) return json([]);
      if (path.endsWith("/organizations"))
        return json([{ id: "prov-1", name: "Alpha Dental", type: "provider" }]);
      if (path.endsWith("/auth/me")) return json(ME);
      return json({});
    }),
  );
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

async function renderPage(firstLabel = "Dr Able") {
  const Wrapper = makeAuthWrapper("/doctors", {
    user: ADMIN_USER,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <DoctorsPage />
    </Wrapper>,
  );
  await screen.findByLabelText(`Select doctor ${firstLabel}`);
}

function stubFetch(cases: unknown[]) {
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
      if (path.endsWith("/cases")) return json(cases);
      if (path.endsWith("/invoices")) return json([]);
      if (path.endsWith("/organizations"))
        return json([{ id: "prov-1", name: "Alpha Dental", type: "provider" }]);
      if (path.endsWith("/auth/me")) return json(ME);
      return json({});
    }),
  );
}

function control(name: string): HTMLElement {
  return screen.getByLabelText(`Select doctor ${name}`);
}

function pickedNames(): string[] {
  return NAMES.filter(
    (n) => control(n).getAttribute("aria-checked") === "true",
  );
}

describe("Doctors shift-click range selection", () => {
  it("selects the range downward (anchor above the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(control("Dr Able"));
    fireEvent.click(control("Dr Dunn"), { shiftKey: true });

    expect(pickedNames()).toEqual(["Dr Able", "Dr Baker", "Dr Cole", "Dr Dunn"]);
  });

  it("selects the range upward (anchor below the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(control("Dr Dunn"));
    fireEvent.click(control("Dr Baker"), { shiftKey: true });

    expect(pickedNames()).toEqual(["Dr Baker", "Dr Cole", "Dr Dunn"]);
  });

  it("adds the range to previously picked doctors outside it", async () => {
    await renderPage();

    fireEvent.click(control("Dr Ellis"));
    fireEvent.click(control("Dr Able"));
    fireEvent.click(control("Dr Cole"), { shiftKey: true });

    expect(pickedNames()).toEqual([
      "Dr Able",
      "Dr Baker",
      "Dr Cole",
      "Dr Ellis",
    ]);
  });

  it("treats a shift-click with no anchor as a single toggle and sets the anchor", async () => {
    await renderPage();

    fireEvent.click(control("Dr Cole"), { shiftKey: true });
    expect(pickedNames()).toEqual(["Dr Cole"]);

    fireEvent.click(control("Dr Ellis"), { shiftKey: true });
    expect(pickedNames()).toEqual(["Dr Cole", "Dr Dunn", "Dr Ellis"]);
  });

  it("keeps normal single toggling intact", async () => {
    await renderPage();

    fireEvent.click(control("Dr Baker"));
    expect(control("Dr Baker").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(control("Dr Baker"));
    expect(control("Dr Baker").getAttribute("aria-checked")).toBe("false");
  });

  // Cases parity: a successful shift-range does NOT move the anchor — only a
  // plain click does. After a shift-range, if the shift-clicked row is later
  // filtered out, a subsequent shift-click must still extend from the original
  // plain-click anchor (still visible), not fall back to a single toggle. This
  // fails if the anchor had been moved to the shift-clicked row and hidden.
  it("keeps the plain-click anchor after a shift-range even when the shift-clicked row is filtered out", async () => {
    // "Zed Jones" lacks the shared "Smith" token so a "Smith" search hides
    // only it while keeping the rest of the doctors in order.
    stubFetch(
      [
        "Anna Smith",
        "Ben Smith",
        "Zed Jones",
        "Dana Smith",
        "Evan Smith",
      ].map((name, idx) => ({
        id: `case-${idx + 1}`,
        doctorName: name,
        providerOrganizationId: "prov-1",
        labOrganizationId: "lab-1",
        status: "in_progress",
        priority: "standard",
        totalPrice: "100.00",
        createdAt: `2026-06-0${idx + 1}T10:00:00.000Z`,
      })),
    );
    await renderPage("Anna Smith");

    // Plain click sets the anchor to Ben, then shift-range to Zed Jones.
    fireEvent.click(control("Ben Smith"));
    fireEvent.click(control("Zed Jones"), { shiftKey: true });

    // Filter out "Zed Jones" (the shift-clicked row) while keeping Ben.
    fireEvent.change(
      screen.getAllByPlaceholderText("Search doctor or practice…")[0],
      { target: { value: "Smith" } },
    );
    await screen.findByLabelText("Select doctor Evan Smith");

    // Shift-click Evan: the anchor is still Ben (visible), so the range
    // Ben..Evan over the visible list adds Dana. If the anchor had moved to the
    // now-hidden Zed, this would fall back to a single toggle of Evan and Dana
    // would stay unselected.
    fireEvent.click(control("Evan Smith"), { shiftKey: true });

    expect(control("Dana Smith").getAttribute("aria-checked")).toBe("true");
  });
});
