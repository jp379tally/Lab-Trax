/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const LAB_ID = "lab-1";
const ADMIN_USER = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  practiceOrganizationId: LAB_ID,
};

const mappings = [
  {
    id: "memory-1",
    doctorName: "jane smith",
    providerOrganizationId: "practice-1",
    practiceName: "Northside Dental",
    practiceAvailable: true,
    updatedAt: "2026-09-01T15:30:00.000Z",
  },
];

function renderSettings() {
  window.history.pushState({}, "", "?tab=doctor-practice-memory");
  const Wrapper = makeAuthWrapper("/settings?tab=doctor-practice-memory", {
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
  window.history.pushState({}, "", "/");
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
});

describe("Settings → Remembered doctor practices", () => {
  it("lists, corrects, and removes a remembered mapping", async () => {
    const postBodies: unknown[] = [];
    const deleteUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();

        if (url.includes("/rx-doctor-practice-memory?")) {
          return new Response(JSON.stringify({ ok: true, data: { mappings } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/rx-doctor-practice-memory") && method === "POST") {
          postBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(
            JSON.stringify({
              ok: true,
              data: { found: true, providerOrganizationId: "practice-2" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/rx-doctor-practice-memory/") && method === "DELETE") {
          deleteUrls.push(url);
          return new Response(
            JSON.stringify({ ok: true, data: { deleted: true } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/organizations")) {
          return new Response(
            JSON.stringify([
              {
                id: "practice-1",
                type: "provider",
                name: "Northside Dental",
                parentLabOrganizationId: LAB_ID,
                isActive: true,
              },
              {
                id: "practice-2",
                type: "provider",
                name: "Lakeside Smiles",
                parentLabOrganizationId: LAB_ID,
                isActive: true,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    renderSettings();

    expect(
      screen.getByRole("button", { name: /Remembered doctor practices/i }),
    ).toBeInTheDocument();
    await screen.findByText("jane smith");
    expect(screen.getByText("Northside Dental")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Practice for jane smith"), {
      target: { value: "practice-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(postBodies).toContainEqual({
        labOrganizationId: LAB_ID,
        doctorName: "jane smith",
        providerOrganizationId: "practice-2",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove mapping" }),
    );

    await waitFor(() => {
      expect(deleteUrls.some((url) => url.endsWith("/memory-1"))).toBe(true);
    });
  });
});