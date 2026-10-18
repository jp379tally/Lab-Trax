/** @vitest-environment jsdom */
/**
 * Settings → Lab Preferences → Templates → Payment receipt.
 *
 * The template is deliberately fetched through /auth/me rather than the auth
 * context alone: the panel needs the active lab-admin membership to discover
 * which lab's receipt defaults it is editing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const LAB_ID = "lab-1";
const SAVED_SUBJECT = "Your payment receipt {{receiptNumber}}";
const SAVED_BODY = "Hello {{customerName}},\n\nWe received your payment.";

const ADMIN_USER = {
  id: "admin-1",
  username: "lab-admin",
  firstName: "Lab",
  lastName: "Admin",
  role: "admin",
};

const MEMBER_USER = {
  id: "member-1",
  username: "lab-member",
  firstName: "Lab",
  lastName: "Member",
  role: "technician",
};

const ME_RESPONSE = {
  user: ADMIN_USER,
  memberships: [{
    id: "membership-1",
    organizationId: LAB_ID,
    role: "admin",
    status: "active",
    organization: { id: LAB_ID, name: "Apex Dental Lab", type: "lab" },
  }],
};

type RequestRecord = { url: string; method: string; body: unknown };
let requests: RequestRecord[] = [];

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });

    if (url.includes("/auth/me")) return json(ME_RESPONSE);
    if (url.includes(`/billing/${LAB_ID}/payment-receipt-template`)) {
      if (method === "PATCH") return json(body);
      return json({
        emailSubject: SAVED_SUBJECT,
        emailBody: SAVED_BODY,
        placeholders: ["{{receiptNumber}}", "{{customerName}}"],
      });
    }

    // Settings mounts a few independent queries. They are irrelevant to this
    // panel, but must receive valid JSON while it is under test.
    return json({ team: [], members: [], items: [], sessions: [], memberships: [] });
  }));
}

function renderSettings(user = ADMIN_USER) {
  window.history.pushState({}, "", "/settings?tab=payment-receipt");
  const Wrapper = makeAuthWrapper("/settings?tab=payment-receipt", {
    user: user as NonNullable<Parameters<typeof makeAuthWrapper>[1]>["user"],
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

function receiptPatchRequests() {
  return requests.filter(
    (request) =>
      request.method === "PATCH" &&
      request.url.includes(`/billing/${LAB_ID}/payment-receipt-template`),
  );
}

beforeEach(() => {
  requests = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
  installFetchMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("Settings payment receipt template", () => {
  it("is visible to admins through Lab Preferences and Templates", async () => {
    renderSettings();

    expect(screen.getByRole("button", { name: "Lab Preferences" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Templates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Payment receipt" })).toBeInTheDocument();
    expect(await screen.findByText("Payment receipt template")).toBeInTheDocument();
  });

  it("loads saved values and explains placeholders and per-send overrides", async () => {
    renderSettings();

    expect(await screen.findByDisplayValue(SAVED_SUBJECT)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Message body")).toHaveValue(SAVED_BODY);
    });
    expect(screen.getByText(/Available placeholders:/i)).toBeInTheDocument();
    expect(screen.getByText("{{receiptNumber}}")).toBeInTheDocument();
    expect(screen.getByText("{{referenceLine}}")).toBeInTheDocument();
    expect(
      screen.getByText(/Edits made while sending an individual receipt do not change this saved default/i),
    ).toBeInTheDocument();
  });

  it("does not expose the template navigation or panel to non-admins", () => {
    renderSettings(MEMBER_USER);

    expect(screen.queryByRole("button", { name: "Templates" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Payment receipt" })).not.toBeInTheDocument();
    expect(screen.queryByText("Payment receipt template")).not.toBeInTheDocument();
  });

  it("shows blank-field validation without issuing a PATCH", async () => {
    renderSettings();
    const subject = await screen.findByLabelText("Subject line");
    fireEvent.change(subject, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    await screen.findByText("Subject line cannot be blank.");
    expect(receiptPatchRequests()).toHaveLength(0);

    fireEvent.change(subject, { target: { value: "A valid subject" } });
    fireEvent.change(screen.getByLabelText("Message body"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    await screen.findByText("Message body cannot be blank.");
    expect(receiptPatchRequests()).toHaveLength(0);
  });

  it("PATCHes trimmed subject and body to the selected lab", async () => {
    renderSettings();
    await screen.findByDisplayValue(SAVED_SUBJECT);
    fireEvent.change(screen.getByLabelText("Subject line"), { target: { value: "  Updated {{receiptNumber}}  " } });
    fireEvent.change(screen.getByLabelText("Message body"), { target: { value: "  Updated receipt message  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    await waitFor(() => {
      expect(receiptPatchRequests()).toEqual([expect.objectContaining({
        body: {
          emailSubject: "Updated {{receiptNumber}}",
          emailBody: "Updated receipt message",
        },
      })]);
    });
  });

  it("restores the system default values for a new save", async () => {
    renderSettings();
    await screen.findByDisplayValue(SAVED_SUBJECT);
    fireEvent.click(screen.getByRole("button", { name: /Restore system default/i }));

    expect(screen.getByLabelText("Subject line")).toHaveValue(
      "Payment receipt from {{labName}} — {{receiptNumber}}",
    );
    expect((screen.getByLabelText("Message body") as HTMLTextAreaElement).value).toContain(
      "Thank you for your payment to {{labName}}.",
    );
    expect((screen.getByLabelText("Message body") as HTMLTextAreaElement).value).toContain(
      "Remaining account balance: {{openBalance}}",
    );
  });
});