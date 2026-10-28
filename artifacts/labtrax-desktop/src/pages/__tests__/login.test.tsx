/** @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

const authMock = vi.hoisted(() => ({
  login: vi.fn(async (_username: string, _password: string, _rememberMe: boolean) => undefined),
  restoreStatus: "empty" as "ok" | "empty" | "keychain-unavailable" | "decrypt-failed" | "session-expired" | "restore-failed",
  restoreNoticeDismissed: false,
  acknowledgeRestoreNotice: vi.fn(),
  register: vi.fn(async () => ({ success: true })),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    login: authMock.login,
    restoreStatus: authMock.restoreStatus,
    restoreNoticeDismissed: authMock.restoreNoticeDismissed,
    acknowledgeRestoreNotice: authMock.acknowledgeRestoreNotice,
    register: authMock.register,
  }),
}));

import LoginPage from "@/pages/login";

beforeEach(() => {
  authMock.login.mockReset();
  authMock.login.mockResolvedValue(undefined);
  authMock.restoreStatus = "empty";
  authMock.restoreNoticeDismissed = false;
  authMock.acknowledgeRestoreNotice.mockReset();
  authMock.register.mockReset();
  sessionStorage.clear();
  localStorage.clear();
  delete (window as Window & { electronAPI?: unknown }).electronAPI;
});

afterEach(() => {
  cleanup();
  delete (window as Window & { electronAPI?: unknown }).electronAPI;
});

describe("desktop sign-in presentation", () => {
  it("shows the browser tab sign-in notice, reveals the password, and submits the credentials", async () => {
    render(<LoginPage />);

    expect(screen.getByRole("heading", { name: "Built for Dental Professionals" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(screen.queryByText("Your lab, connected")).toBeNull();
    for (const mark of screen.getAllByAltText("LabTrax")) {
      expect(mark).toHaveAttribute("src", expect.stringContaining("signin-reference-mark.png"));
    }

    const username = screen.getByLabelText("Username") as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    fireEvent.change(username, { target: { value: "  labuser  " } });
    fireEvent.change(password, { target: { value: "dental-secret" } });
    expect(password.type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");

    expect(screen.getByText("This tab won't retain your sign-in after you close it.")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Remember me" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(authMock.login).toHaveBeenCalledWith("labuser", "dental-secret", false));
  });

  it("keeps Remember me available in Electron", () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {},
    });
    render(<LoginPage />);

    expect(screen.getByRole("checkbox", { name: "Remember me" })).toBeInTheDocument();
    expect(screen.queryByText(/This tab won't retain your sign-in/)).toBeNull();
  });

  it("announces failed sign-in and keeps account creation and recovery entry points connected", async () => {
    authMock.login.mockRejectedValue(new Error("Invalid username or password."));
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "labuser" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password.");

    fireEvent.click(screen.getByRole("button", { name: "Forgot username?" }));
    expect(screen.getByRole("heading", { name: "Recover your username" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    expect(screen.getByRole("heading", { name: "Welcome to LabTrax" })).toBeTruthy();
  });

  it("shows and dismisses inactivity and saved-session notices", () => {
    sessionStorage.setItem("labtrax_idle_logout_v1", "true");
    authMock.restoreStatus = "decrypt-failed";
    render(<LoginPage />);

    expect(screen.getByTestId("idle-logout-notice")).toHaveTextContent("signed out due to inactivity");
    expect(screen.getByTestId("auth-restore-toast")).toHaveTextContent(
      "couldn't read the saved sign-in",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss session notice" }));
    expect(authMock.acknowledgeRestoreNotice).toHaveBeenCalledTimes(1);
  });

  it("shows a distinct actionable notice when the restored server session expired", () => {
    authMock.restoreStatus = "session-expired";
    render(<LoginPage />);

    expect(screen.getByTestId("auth-restore-toast")).toHaveTextContent(
      "the session has expired",
    );
    expect(screen.getByTestId("auth-restore-toast")).toHaveTextContent(
      "Sign in again to continue",
    );
  });
});
