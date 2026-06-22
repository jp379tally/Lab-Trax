/** @vitest-environment jsdom */
/**
 * Unit tests for AiChatPanel mic-button label logic.
 *
 * Invariants protected:
 *  - When mic access is denied (NotAllowedError / PermissionDeniedError /
 *    SecurityError), the button aria-label and title read
 *    "Microphone blocked — click to dismiss".
 *  - When mic access fails for any other reason (device unavailable,
 *    recording error, transcription failure, etc.), the label reads
 *    "Microphone error — click to dismiss".
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { AiChatPanel } from "../AiChatPanel";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn().mockResolvedValue({ cases: [] }),
  getAccessToken: vi.fn(() => null),
  apiUrl: vi.fn((path: string) => `/api${path}`),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(msg: string, status = 500) {
      super(msg);
      this.status = status;
    }
  },
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
}));

// ─── jsdom stubs ─────────────────────────────────────────────────────────────

window.HTMLElement.prototype.scrollIntoView = vi.fn();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPanel() {
  const Wrapper = makeAuthWrapper();
  return render(<AiChatPanel onClose={() => {}} />, { wrapper: Wrapper });
}

function stubGetUserMedia(rejectWith: Error) {
  Object.defineProperty(window, "navigator", {
    value: {
      ...window.navigator,
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(rejectWith),
      },
    },
    writable: true,
    configurable: true,
  });
}

function makePermissionError(name: string) {
  const err = new Error(name);
  err.name = name;
  return err;
}

async function waitForMicReady() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AiChatPanel — mic button label on NotAllowedError (permission denial)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aria-label reads "Microphone blocked — click to dismiss" on NotAllowedError', async () => {
    stubGetUserMedia(makePermissionError("NotAllowedError"));
    renderPanel();
    await waitForMicReady();

    const micBtn = screen.getByRole("button", { name: /dictate message/i });
    await act(async () => {
      micBtn.click();
    });

    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /microphone blocked/i });
      expect(btn.getAttribute("aria-label")).toBe(
        "Microphone blocked — click to dismiss",
      );
      expect(btn.getAttribute("title")).toBe(
        "Microphone blocked — click to dismiss",
      );
    });
  });

  it('aria-label reads "Microphone blocked — click to dismiss" on PermissionDeniedError', async () => {
    stubGetUserMedia(makePermissionError("PermissionDeniedError"));
    renderPanel();
    await waitForMicReady();

    const micBtn = screen.getByRole("button", { name: /dictate message/i });
    await act(async () => {
      micBtn.click();
    });

    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /microphone blocked/i });
      expect(btn.getAttribute("aria-label")).toBe(
        "Microphone blocked — click to dismiss",
      );
      expect(btn.getAttribute("title")).toBe(
        "Microphone blocked — click to dismiss",
      );
    });
  });

  it('aria-label reads "Microphone blocked — click to dismiss" on SecurityError', async () => {
    stubGetUserMedia(makePermissionError("SecurityError"));
    renderPanel();
    await waitForMicReady();

    const micBtn = screen.getByRole("button", { name: /dictate message/i });
    await act(async () => {
      micBtn.click();
    });

    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /microphone blocked/i });
      expect(btn.getAttribute("aria-label")).toBe(
        "Microphone blocked — click to dismiss",
      );
      expect(btn.getAttribute("title")).toBe(
        "Microphone blocked — click to dismiss",
      );
    });
  });
});

describe("AiChatPanel — mic button label on non-permission error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aria-label reads "Microphone error — click to dismiss" on a generic device error', async () => {
    stubGetUserMedia(new Error("Could not start audio source"));
    renderPanel();
    await waitForMicReady();

    const micBtn = screen.getByRole("button", { name: /dictate message/i });
    await act(async () => {
      micBtn.click();
    });

    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /microphone error/i });
      expect(btn.getAttribute("aria-label")).toBe(
        "Microphone error — click to dismiss",
      );
      expect(btn.getAttribute("title")).toBe(
        "Microphone error — click to dismiss",
      );
    });
  });

  it('aria-label reads "Microphone error — click to dismiss" on an AbortError (device taken by another app)', async () => {
    stubGetUserMedia(makePermissionError("AbortError"));
    renderPanel();
    await waitForMicReady();

    const micBtn = screen.getByRole("button", { name: /dictate message/i });
    await act(async () => {
      micBtn.click();
    });

    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /microphone error/i });
      expect(btn.getAttribute("aria-label")).toBe(
        "Microphone error — click to dismiss",
      );
      expect(btn.getAttribute("title")).toBe(
        "Microphone error — click to dismiss",
      );
    });
  });
});
