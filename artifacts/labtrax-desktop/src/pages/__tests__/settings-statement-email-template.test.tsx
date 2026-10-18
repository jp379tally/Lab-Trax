/** @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext, type AuthContextValue } from "@/lib/auth-context";
import SettingsPage from "@/pages/settings";

const DEFAULT_SUBJECT = "Statement for {{practiceName}} — {{periodLabel}}";
const DEFAULT_BODY =
  "Hello {{practiceName}},\n\nPlease find attached the statement for {{practiceName}} covering {{periodLabel}}.\n\nThank you,\n{{labName}}";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

const AUTH_VALUE: AuthContextValue = {
  user: {
    id: "admin-1",
    username: "admin",
    role: "admin",
    practiceOrganizationId: "lab-1",
  } as AuthContextValue["user"],
  status: "authed",
  restoreStatus: "ok",
  restoreNoticeDismissed: true,
  acknowledgeRestoreNotice: () => {},
  login: async () => {},
  register: async () => ({ user: null as never, token: "" }),
  logout: async () => {},
  refresh: async () => {},
};

function renderStatementEmailSettings() {
  window.history.pushState({}, "", "/settings?tab=statement-email");
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
  const { hook } = memoryLocation({ path: "/settings?tab=statement-email" });

  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={hook}>
        <AuthContext.Provider value={AUTH_VALUE}>
          <SettingsPage />
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (endpoint: string, init?: RequestInit) => {
    if (endpoint === "/admin/templates/statement-email") {
      if (init?.method === "PATCH") return { success: true };
      return { emailSubject: null, emailBody: null };
    }
    if (endpoint === "/auth/lab-team") {
      return { team: [], members: [], callerRole: "admin", pendingInvites: [], pendingJoinRequests: [] };
    }
    return {};
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("Settings — statement email template", () => {
  it("loads system defaults as editable values, saves edits, and resets to editable defaults", async () => {
    renderStatementEmailSettings();

    const subject = await screen.findByRole("textbox", { name: "Subject line" });
    const body = screen.getByRole("textbox", { name: "Message body" });

    expect(subject).toHaveValue(DEFAULT_SUBJECT);
    expect(subject).not.toHaveAttribute("placeholder");
    expect(body).toHaveValue(DEFAULT_BODY);
    expect(body).not.toHaveAttribute("placeholder");
    expect((body as HTMLTextAreaElement).value).not.toMatch(/^Hello,\n/);

    const editedSubject = `Important: ${DEFAULT_SUBJECT}`;
    const editedBody = DEFAULT_BODY.replace("Please find", "You can find");
    fireEvent.change(subject, { target: { value: editedSubject } });
    fireEvent.change(body, { target: { value: editedBody } });

    expect(subject).toHaveValue(editedSubject);
    expect(body).toHaveValue(editedBody);

    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/admin/templates/statement-email",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            emailSubject: editedSubject,
            emailBody: editedBody,
          }),
        }),
      );
    });

    fireEvent.change(subject, { target: { value: "Another subject" } });
    fireEvent.change(body, { target: { value: "Another body" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to system default" }));

    expect(subject).toHaveValue(DEFAULT_SUBJECT);
    expect(body).toHaveValue(DEFAULT_BODY);
    expect(screen.getByRole("button", { name: /^(Save template|Saved)$/ })).toBeEnabled();
  });

  it("loads a saved template as editable field values when reopened", async () => {
    apiFetchMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/admin/templates/statement-email") {
        return { emailSubject: "Saved subject", emailBody: "Saved message" };
      }
      if (endpoint === "/auth/lab-team") {
        return { team: [], members: [], callerRole: "admin", pendingInvites: [], pendingJoinRequests: [] };
      }
      return {};
    });

    renderStatementEmailSettings();

    expect(await screen.findByRole("textbox", { name: "Subject line" })).toHaveValue("Saved subject");
    expect(screen.getByRole("textbox", { name: "Message body" })).toHaveValue("Saved message");
  });
});