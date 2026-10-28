/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authApi = vi.hoisted(() => ({
  restoreStatus: "keychain-unavailable" as
    | "ok"
    | "empty"
    | "keychain-unavailable"
    | "decrypt-failed"
    | "session-expired"
    | "restore-failed",
  fetchMe: vi.fn(),
  getAuthRestoreStatus: vi.fn(() => authApi.restoreStatus),
  login: vi.fn(),
  logout: vi.fn(),
  register: vi.fn(),
  retrySavedAuthRestore: vi.fn(),
  subscribeSession: vi.fn(() => () => {}),
  waitForTokenHydration: vi.fn(async () => {}),
  installBrowserTabCloseSignOut: vi.fn(() => () => {}),
}));

vi.mock("../api", () => authApi);

import { AuthProvider, useAuth } from "../auth-context";

function AuthStatusProbe() {
  const { status, restoreStatus } = useAuth();
  return <div data-testid="auth-state">{`${status}:${restoreStatus}`}</div>;
}

beforeEach(() => {
  vi.useFakeTimers();
  authApi.restoreStatus = "keychain-unavailable";
  authApi.fetchMe.mockReset();
  authApi.fetchMe.mockRejectedValueOnce(new Error("No saved session"));
  authApi.getAuthRestoreStatus.mockImplementation(() => authApi.restoreStatus);
  authApi.retrySavedAuthRestore.mockReset();
  authApi.retrySavedAuthRestore.mockResolvedValue("keychain-unavailable");
  authApi.waitForTokenHydration.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AuthProvider keychain recovery", () => {
  it("retries while signed out and verifies the saved session when keychain access returns", async () => {
    authApi.fetchMe.mockResolvedValue({
      id: "saved-user",
      username: "labuser",
    });
    render(
      <AuthProvider>
        <AuthStatusProbe />
      </AuthProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("auth-state")).toHaveTextContent(
      "anonymous:keychain-unavailable",
    );
    expect(authApi.retrySavedAuthRestore).toHaveBeenCalledTimes(1);

    authApi.restoreStatus = "ok";
    authApi.retrySavedAuthRestore.mockResolvedValue("ok");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(authApi.fetchMe).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("auth-state")).toHaveTextContent("authed:ok");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(authApi.retrySavedAuthRestore).toHaveBeenCalledTimes(2);
  });

  it("keeps the unavailable status visible and continues retrying after a failed check", async () => {
    render(
      <AuthProvider>
        <AuthStatusProbe />
      </AuthProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authApi.retrySavedAuthRestore).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(authApi.retrySavedAuthRestore).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("auth-state")).toHaveTextContent(
      "anonymous:keychain-unavailable",
    );
  });

  it("shows a clear failure status if restored credentials cannot be verified by the server", async () => {
    authApi.fetchMe.mockRejectedValueOnce(new Error("No saved session"));
    authApi.fetchMe.mockRejectedValueOnce(new Error("Server unavailable"));
    render(
      <AuthProvider>
        <AuthStatusProbe />
      </AuthProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    authApi.restoreStatus = "ok";
    authApi.retrySavedAuthRestore.mockResolvedValue("ok");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByTestId("auth-state")).toHaveTextContent(
      "anonymous:restore-failed",
    );
  });
});
