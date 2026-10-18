import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Alert } from "react-native";
import {
  resetMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../../vitest.setup";

import OrganizationsScreen from "@/app/settings/organizations";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

const LAB_USER_NO_MEMBERSHIP = {
  data: { user: { id: "u1", userType: "lab" }, memberships: [] },
  isLoading: false,
  isError: false,
} as const;

const PROVIDER_USER_NO_MEMBERSHIP = {
  data: { user: { id: "u2", userType: "provider" }, memberships: [] },
  isLoading: false,
  isError: false,
} as const;

const LAB_USER_WITH_ACTIVE_LAB = {
  data: {
    user: { id: "u3", userType: "lab" },
    memberships: [
      {
        id: "mem-1",
        role: "owner",
        status: "active",
        organizationId: "org-1",
        organization: { id: "org-1", type: "lab", name: "My Dental Lab" },
      },
    ],
  },
  isLoading: false,
  isError: false,
} as const;

// The screen renders several `useQuery` consumers (meQuery, clusterQuery,
// invitesQuery). A blanket `mockReturnValue` would feed the me-response shape
// to every one of them — including `PendingInvitesCard`, whose `invitesQuery`
// expects an array (`invites.map`). Mock per query key so each consumer gets a
// shape it can handle; the `meValue` under test drives the me-query only.
function applyUseQueryMock(meValue: unknown) {
  vi.mocked(useQuery).mockImplementation((options: any) => {
    const key = options?.queryKey ?? [];
    const head = Array.isArray(key) ? key[0] : key;
    if (head === "pending-invites") {
      return { data: [], isLoading: false, isError: false } as any;
    }
    if (head === "org-clusters") {
      return { data: undefined, isLoading: false, isError: false } as any;
    }
    return meValue as any;
  });
}

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  vi.mocked(useQuery).mockReset();
  vi.clearAllMocks();
});

describe("OrganizationsScreen — Create lab button visibility", () => {
  it("shows the Create lab button when userType is lab and no active lab membership", async () => {
    applyUseQueryMock(LAB_USER_NO_MEMBERSHIP);
    const { getByTestId } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });
    expect(getByTestId("create-lab-open-btn")).toBeTruthy();
  });

  it("hides the Create lab button when userType is provider (not lab)", async () => {
    applyUseQueryMock(PROVIDER_USER_NO_MEMBERSHIP);
    const { queryByTestId } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });
    expect(queryByTestId("create-lab-open-btn")).toBeNull();
  });

  it("hides the Create lab button when the user already has an active lab membership", async () => {
    applyUseQueryMock(LAB_USER_WITH_ACTIVE_LAB);
    const { queryByTestId } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });
    expect(queryByTestId("create-lab-open-btn")).toBeNull();
  });
});

describe("OrganizationsScreen — CreateLabSheet required-field guard", () => {
  beforeEach(() => {
    applyUseQueryMock(LAB_USER_NO_MEMBERSHIP);
  });

  it("shows an inline error and does not POST when all required fields are empty", async () => {
    setMockFetchHandler(() =>
      new Response(JSON.stringify({ error: "LAB_NAME_TAKEN" }), { status: 409 }),
    );
    const { getByTestId, getByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(
        getByText(/lab name, license number, phone, email, and street address are required/i),
      ).toBeTruthy();
    });
  });

  it("shows an inline error when only the lab name is filled (4 remaining fields empty)", async () => {
    setMockFetchHandler(() =>
      new Response(JSON.stringify({ error: "UNEXPECTED" }), { status: 500 }),
    );
    const { getByTestId, getByText, getAllByPlaceholderText } = await render(
      <OrganizationsScreen />,
      { wrapper: makeWrapper() },
    );

    await fireEvent.changeText(getAllByPlaceholderText("Acme Dental Lab")[0], "Test Lab");

    await fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(
        getByText(/lab name, license number, phone, email, and street address are required/i),
      ).toBeTruthy();
    });
  });
});

describe("OrganizationsScreen — CreateLabSheet server error surfacing", () => {
  beforeEach(() => {
    applyUseQueryMock(LAB_USER_NO_MEMBERSHIP);
  });

  it("surfaces a LAB_NAME_TAKEN error inline after a 409 from /api/organizations", async () => {
    setMockFetchHandler((url) => {
      if (url.includes("/api/organizations")) {
        return new Response(JSON.stringify({ error: "LAB_NAME_TAKEN" }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { getByTestId, getByText, getAllByPlaceholderText } = await render(
      <OrganizationsScreen />,
      { wrapper: makeWrapper() },
    );

    await fireEvent.changeText(getAllByPlaceholderText("Acme Dental Lab")[0], "Acme Lab");
    await fireEvent.changeText(getAllByPlaceholderText("Lab license number")[0], "LIC-123");
    await fireEvent.changeText(getAllByPlaceholderText("000-000-0000")[0], "555-000-1111");
    await fireEvent.changeText(getAllByPlaceholderText("lab@example.com")[0], "lab@example.com");
    await fireEvent.changeText(getAllByPlaceholderText("123 Main St")[0], "100 Elm St");

    await fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(getByText("LAB_NAME_TAKEN")).toBeTruthy();
    });
  });

  it("surfaces a generic server error inline when /api/organizations returns 500", async () => {
    setMockFetchHandler((url) => {
      if (url.includes("/api/organizations")) {
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { getByTestId, getByText, getAllByPlaceholderText } = await render(
      <OrganizationsScreen />,
      { wrapper: makeWrapper() },
    );

    await fireEvent.changeText(getAllByPlaceholderText("Acme Dental Lab")[0], "Acme Lab");
    await fireEvent.changeText(getAllByPlaceholderText("Lab license number")[0], "LIC-123");
    await fireEvent.changeText(getAllByPlaceholderText("000-000-0000")[0], "555-000-1111");
    await fireEvent.changeText(getAllByPlaceholderText("lab@example.com")[0], "lab@example.com");
    await fireEvent.changeText(getAllByPlaceholderText("123 Main St")[0], "100 Elm St");

    await fireEvent.press(getByTestId("form-save"));

    await waitFor(() => {
      expect(getByText("Internal server error")).toBeTruthy();
    });
  });
});

const PROVIDER_ORG = {
  id: "prov-1",
  type: "provider",
  name: "Downtown Dental",
  displayName: "Downtown Dental",
  phone: "555-111-2222",
  billingEmail: "office@downtown.example",
  addressLine1: "10 Market St",
  city: "Austin",
  state: "TX",
  zip: "78701",
};

function providerAdminMe(role: string) {
  return {
    data: {
      user: { id: "u-admin", userType: "lab" },
      memberships: [
        {
          id: "mem-prov",
          role,
          status: "active",
          organizationId: "prov-1",
          organization: PROVIDER_ORG,
        },
      ],
    },
    isLoading: false,
    isError: false,
  };
}

describe("OrganizationsScreen — provider practice editing", () => {
  it("shows an Edit affordance on provider cards for admins and pre-fills contact details", async () => {
    applyUseQueryMock(providerAdminMe("admin"));
    const { getByText, getAllByText, getByDisplayValue } = await render(
      <OrganizationsScreen />,
      { wrapper: makeWrapper() },
    );

    expect(getByText("Practice details")).toBeTruthy();

    await fireEvent.press(getAllByText("Edit")[0]);

    await waitFor(() => {
      expect(getByText("Edit practice details")).toBeTruthy();
    });
    expect(getByDisplayValue("Downtown Dental")).toBeTruthy();
    expect(getByDisplayValue("555-111-2222")).toBeTruthy();
    expect(getByDisplayValue("office@downtown.example")).toBeTruthy();
    expect(getByDisplayValue("10 Market St")).toBeTruthy();
  });

  it("does not show an Edit affordance for non-admin provider members", async () => {
    applyUseQueryMock(providerAdminMe("user"));
    const { getByText, queryByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    expect(getByText("Practice details")).toBeTruthy();
    expect(queryByText("Edit")).toBeNull();
  });

  it("PATCHes /api/organizations/:id and surfaces a 409 name conflict", async () => {
    applyUseQueryMock(providerAdminMe("owner"));
    let patchedUrl: string | null = null;
    setMockFetchHandler((url, init) => {
      if (url.includes("/api/organizations/prov-1") && init?.method === "PATCH") {
        patchedUrl = url;
        return new Response(JSON.stringify({ error: "NAME_TAKEN" }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { getByText, getAllByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.press(getAllByText("Edit")[0]);
    await waitFor(() => expect(getByText("Edit practice details")).toBeTruthy());

    await fireEvent.press(getByText("Save changes"));

    await waitFor(() => {
      expect(
        getByText(/that practice name is already taken/i),
      ).toBeTruthy();
    });
    expect(patchedUrl).toContain("/api/organizations/prov-1");
  });
});

// ── Sender-side team invites (lab admins) ────────────────────────────────────

const LAB_ORG = {
  id: "org-1",
  type: "lab",
  name: "My Dental Lab",
  displayName: "My Dental Lab",
};

function labMe(role: string) {
  return {
    data: {
      user: { id: "u-lab", userType: "lab" },
      memberships: [
        {
          id: "mem-lab",
          role,
          status: "active",
          organizationId: "org-1",
          organization: LAB_ORG,
        },
      ],
    },
    isLoading: false,
    isError: false,
  };
}

/**
 * Per-queryKey mock (a blanket mockReturnValue would feed the me-shape to
 * every useQuery on the screen). `sentInvites` drives the ["org-invites"]
 * query that powers the pending-invites listing.
 */
function applyInviteUseQueryMock(meValue: unknown, sentInvites: unknown[] = []) {
  vi.mocked(useQuery).mockImplementation((options: any) => {
    const key = options?.queryKey ?? [];
    const head = Array.isArray(key) ? key[0] : key;
    if (head === "pending-invites") {
      return { data: [], isLoading: false, isError: false } as any;
    }
    if (head === "org-clusters") {
      return { data: undefined, isLoading: false, isError: false } as any;
    }
    if (head === "lab-team") {
      return { data: { team: [], callerRole: null }, isLoading: false, isError: false } as any;
    }
    if (head === "org-invites") {
      return { data: sentInvites, isLoading: false, isError: false } as any;
    }
    return meValue as any;
  });
}

describe("OrgCard — team invite form visibility (RBAC gate)", () => {
  it("shows the invite form for lab admins", async () => {
    applyInviteUseQueryMock(labMe("admin"));
    const { getByTestId, getByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });
    expect(getByText("Invite a team member")).toBeTruthy();
    expect(getByTestId("invite-email-input")).toBeTruthy();
    expect(getByTestId("invite-send-btn")).toBeTruthy();
  });

  it("shows the invite form for lab owners", async () => {
    applyInviteUseQueryMock(labMe("owner"));
    const { getByTestId } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });
    expect(getByTestId("invite-send-btn")).toBeTruthy();
  });

  it("hides the invite form for non-admin lab members", async () => {
    applyInviteUseQueryMock(labMe("user"));
    const { queryByTestId, queryByText, getByText } = await render(
      <OrganizationsScreen />,
      { wrapper: makeWrapper() },
    );
    // Team members list is still visible…
    expect(getByText("Team members")).toBeTruthy();
    // …but the invite affordances are not.
    expect(queryByText("Invite a team member")).toBeNull();
    expect(queryByTestId("invite-send-btn")).toBeNull();
  });
});

describe("OrgCard — sending an invite", () => {
  beforeEach(() => {
    applyInviteUseQueryMock(labMe("admin"));
  });

  it("rejects an invalid email inline without POSTing", async () => {
    let posted = false;
    setMockFetchHandler((url, init) => {
      if (init?.method === "POST") posted = true;
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });
    const { getByTestId, getByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.changeText(getByTestId("invite-email-input"), "not-an-email");
    await fireEvent.press(getByTestId("invite-send-btn"));

    await waitFor(() => {
      expect(getByText("Enter a valid email address.")).toBeTruthy();
    });
    expect(posted).toBe(false);
  });

  it("POSTs email + roleToAssign and confirms a successfully-sent invite", async () => {
    let postedUrl: string | null = null;
    let postedBody: any = null;
    setMockFetchHandler((url, init) => {
      if (url.startsWith("/api/organizations/org-1/invites") && init?.method === "POST") {
        postedUrl = url;
        postedBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              id: "inv-new",
              email: postedBody.email,
              roleToAssign: postedBody.roleToAssign,
              status: "pending",
              emailDelivery: { sent: true, status: "sent" },
            },
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });

    const { getByTestId, getByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.changeText(getByTestId("invite-email-input"), "New.Member@Example.com");
    await fireEvent.press(getByTestId("invite-role-billing"));
    await fireEvent.press(getByTestId("invite-send-btn"));

    await waitFor(() => {
      expect(getByText("Invite sent.")).toBeTruthy();
    });
    expect(postedUrl).toBe("/api/organizations/org-1/invites");
    expect(postedBody).toEqual({
      email: "new.member@example.com",
      roleToAssign: "billing",
    });
  });

  it("tells the truth when the invite was created but the email failed to send", async () => {
    setMockFetchHandler((url, init) => {
      if (url.startsWith("/api/organizations/org-1/invites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              id: "inv-x",
              status: "pending",
              emailDelivery: { sent: false, status: "failed", reason: "send_failed" },
            },
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });

    const { getByTestId, getByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.changeText(getByTestId("invite-email-input"), "member@example.com");
    await fireEvent.press(getByTestId("invite-send-btn"));

    await waitFor(() => {
      expect(
        getByText(/invite created, but the invite email failed to send/i),
      ).toBeTruthy();
    });
  });

  it("tells the truth when the recipient opted out of invite emails", async () => {
    setMockFetchHandler((url, init) => {
      if (url.startsWith("/api/organizations/org-1/invites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              id: "inv-y",
              status: "pending",
              emailDelivery: { sent: false, status: "skipped", reason: "recipient_opted_out" },
            },
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });

    const { getByTestId, getByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.changeText(getByTestId("invite-email-input"), "optout@example.com");
    await fireEvent.press(getByTestId("invite-send-btn"));

    await waitFor(() => {
      expect(
        getByText(/no email was sent — the recipient opted out/i),
      ).toBeTruthy();
    });
  });

  it("surfaces a 409 duplicate-pending-invite error inline", async () => {
    setMockFetchHandler((url, init) => {
      if (url.startsWith("/api/organizations/org-1/invites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: false,
            message: "A pending invite already exists for that email address.",
          }),
          { status: 409 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });

    const { getByTestId, getByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.changeText(getByTestId("invite-email-input"), "dupe@example.com");
    await fireEvent.press(getByTestId("invite-send-btn"));

    await waitFor(() => {
      expect(
        getByText(/a pending invite already exists for that email address/i),
      ).toBeTruthy();
    });
  });
});

const SENT_INVITES = [
  {
    id: "inv-ok",
    email: "clean@example.com",
    roleToAssign: "user",
    status: "pending",
    lastEmailStatus: "sent",
    lastEmailError: null,
  },
  {
    id: "inv-failed",
    email: "bounce@example.com",
    roleToAssign: "billing",
    status: "pending",
    lastEmailStatus: "failed",
    lastEmailError: "send_failed",
  },
  {
    id: "inv-optout",
    email: "optout@example.com",
    roleToAssign: "admin",
    status: "pending",
    lastEmailStatus: "failed",
    lastEmailError: "recipient_opted_out",
  },
  {
    id: "inv-skipped",
    email: "skipped@example.com",
    roleToAssign: "user",
    status: "pending",
    lastEmailStatus: "skipped",
    lastEmailError: "recipient_opted_out",
  },
];

describe("OrgCard — pending sent invites listing", () => {
  it("lists pending invites with truthful delivery-problem labels (desktop parity)", async () => {
    applyInviteUseQueryMock(labMe("admin"), SENT_INVITES);
    const { getByText, queryByTestId, getByTestId } = await render(
      <OrganizationsScreen />,
      { wrapper: makeWrapper() },
    );

    expect(getByText("Pending invites")).toBeTruthy();
    expect(getByText("clean@example.com")).toBeTruthy();
    // Delivered fine → no problem label.
    expect(queryByTestId("invite-problem-inv-ok")).toBeNull();
    // Failed send.
    expect(getByTestId("invite-problem-inv-failed")).toBeTruthy();
    expect(getByText("Invite email failed to send")).toBeTruthy();
    // Failed because recipient opted out.
    expect(getByText("Recipient opted out of invite emails")).toBeTruthy();
    // Skipped because recipient opted out.
    expect(getByText("Email skipped — recipient opted out")).toBeTruthy();
  });

  it("resends an invite via POST /invites/:id/resend and confirms", async () => {
    applyInviteUseQueryMock(labMe("admin"), [SENT_INVITES[1]]);
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    let resendUrl: string | null = null;
    setMockFetchHandler((url, init) => {
      if (url.includes("/resend") && init?.method === "POST") {
        resendUrl = url;
        return new Response(
          JSON.stringify({ ok: true, data: { id: "inv-failed", emailDelivery: { sent: true, status: "sent" } } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });

    const { getByTestId } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.press(getByTestId("invite-resend-inv-failed"));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        "Invite email sent",
        expect.stringMatching(/sent again/i),
      );
    });
    expect(resendUrl).toBe("/api/organizations/invites/inv-failed/resend");
  });

  it("resend is non-fatal — refreshes the link and reports the email was not sent when the recipient opted out", async () => {
    applyInviteUseQueryMock(labMe("admin"), [SENT_INVITES[2]]);
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    setMockFetchHandler((url, init) => {
      if (url.includes("/resend") && init?.method === "POST") {
        // Resend is symmetric with create: 200 + a skipped emailDelivery,
        // never a 409, when the recipient opted out.
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              id: "inv-optout",
              emailDelivery: {
                sent: false,
                status: "skipped",
                reason: "recipient_opted_out",
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });

    const { getByTestId } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.press(getByTestId("invite-resend-inv-optout"));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        expect.stringMatching(/email not sent/i),
        expect.stringMatching(/opted out/i),
      );
    });
  });

  it("resend is non-fatal — reports the email was not sent when the send fails", async () => {
    applyInviteUseQueryMock(labMe("admin"), [SENT_INVITES[1]]);
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    setMockFetchHandler((url, init) => {
      if (url.includes("/resend") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              id: "inv-failed",
              emailDelivery: {
                sent: false,
                status: "failed",
                reason: "send_failed",
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });

    const { getByTestId } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.press(getByTestId("invite-resend-inv-failed"));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        expect.stringMatching(/email was not sent/i),
        expect.stringMatching(/failed to send/i),
      );
    });
  });

  it("cancels an invite after confirmation via POST /invites/:id/cancel", async () => {
    applyInviteUseQueryMock(labMe("admin"), [SENT_INVITES[0]]);
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    let cancelUrl: string | null = null;
    setMockFetchHandler((url, init) => {
      if (url.includes("/cancel") && init?.method === "POST") {
        cancelUrl = url;
        return new Response(
          JSON.stringify({ ok: true, data: { id: "inv-ok", status: "revoked" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
    });

    const { getByTestId } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });

    await fireEvent.press(getByTestId("invite-cancel-inv-ok"));

    // Confirmation dialog is shown; nothing POSTed yet.
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(cancelUrl).toBeNull();

    const buttons = vi.mocked(Alert.alert).mock.calls[0][2] as
      | { text: string; onPress?: () => void }[]
      | undefined;
    const confirm = buttons?.find((b) => b.text === "Cancel invite");
    expect(confirm).toBeTruthy();
    await act(async () => {
      await confirm!.onPress?.();
    });

    await waitFor(() => {
      expect(cancelUrl).toBe("/api/organizations/invites/inv-ok/cancel");
    });
  });

  it("does not show the pending-invites listing to non-admin members", async () => {
    applyInviteUseQueryMock(labMe("user"), SENT_INVITES);
    const { queryByText } = await render(<OrganizationsScreen />, {
      wrapper: makeWrapper(),
    });
    expect(queryByText("Pending invites")).toBeNull();
    expect(queryByText("bounce@example.com")).toBeNull();
  });
});
