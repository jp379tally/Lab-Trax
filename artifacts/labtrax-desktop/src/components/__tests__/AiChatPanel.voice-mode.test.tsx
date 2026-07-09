/** @vitest-environment jsdom */
/**
 * Regression tests for the Maynard voice-conversation (headphones) button.
 *
 * Invariants protected (fix: voice conversation mic on web):
 *  - Toggling voice mode ON from an idle state immediately starts microphone
 *    capture (getUserMedia + MediaRecorder.start) from the click gesture —
 *    previously it only flipped the boolean and the mic never turned on.
 *  - Toggling voice mode OFF stops the recorder and stops all MediaStream
 *    tracks so the browser mic indicator turns off.
 *  - If getUserMedia is denied on voice-mode entry, the mic error banner is
 *    shown (same banner dictation uses).
 *  - Unmounting the panel while listening stops all MediaStream tracks.
 *  - Dictation (mic button) behavior is unchanged: it still starts capture.
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

/** Track/recorder spies re-created per test via stubMedia(). */
let trackStop = vi.fn();
let recorderStart = vi.fn();
let recorderStop = vi.fn();
let getUserMediaMock = vi.fn();
let fetchMock = vi.fn();

/** Transcript returned by the stubbed /ai-stt endpoint. */
const STT_TRANSCRIPT = "hello maynard";

function stubMedia(opts?: { rejectWith?: Error }) {
  trackStop = vi.fn();
  recorderStart = vi.fn();
  recorderStop = vi.fn();

  const fakeStream = {
    getTracks: () => [{ stop: trackStop }],
  };

  getUserMediaMock = opts?.rejectWith
    ? vi.fn().mockRejectedValue(opts.rejectWith)
    : vi.fn().mockResolvedValue(fakeStream);

  Object.defineProperty(window, "navigator", {
    value: {
      ...window.navigator,
      mediaDevices: { getUserMedia: getUserMediaMock },
    },
    writable: true,
    configurable: true,
  });

  class FakeMediaRecorder {
    ondataavailable: ((e: unknown) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    mimeType = "audio/webm";
    start = recorderStart;
    stop = () => {
      recorderStop();
      // Real MediaRecorder fires onstop asynchronously after stop().
      queueMicrotask(() => this.onstop?.());
    };
  }
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;

  // Stub raw fetch for the STT + streaming endpoints used by the panel.
  fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/ai-stt")) {
      return new Response(JSON.stringify({ ok: true, transcript: STT_TRANSCRIPT }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // /ai-agent/stream and anything else: fail fast — sendMessage still appends
    // the user's message before dispatching, which is what these tests assert.
    return new Response(JSON.stringify({ ok: false, error: "unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPanel() {
  const Wrapper = makeAuthWrapper();
  return render(<AiChatPanel onClose={() => {}} />, { wrapper: Wrapper });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AiChatPanel — voice-conversation toggle starts mic capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    stubMedia();
  });

  it("entering voice mode from idle calls getUserMedia and starts the recorder", async () => {
    renderPanel();
    await settle();

    const voiceBtn = screen.getByRole("button", { name: /start voice conversation/i });
    await act(async () => {
      voiceBtn.click();
    });

    await waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
      expect(recorderStart).toHaveBeenCalled();
    });

    // Button flipped to the "exit" state and the mic button shows listening.
    expect(screen.getByRole("button", { name: /exit voice mode/i })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /stop listening/i })).toBeTruthy();
    });
  });

  it("exiting voice mode stops the recorder and all MediaStream tracks", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalled());

    await act(async () => {
      screen.getByRole("button", { name: /exit voice mode/i }).click();
    });

    await waitFor(() => {
      expect(recorderStop).toHaveBeenCalled();
      expect(trackStop).toHaveBeenCalled();
    });
    expect(screen.getByRole("button", { name: /start voice conversation/i })).toBeTruthy();
  });

  it("unmounting the panel while listening stops all MediaStream tracks", async () => {
    const { unmount } = renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalled());

    unmount();

    expect(recorderStop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });

  it("in voice mode, stopping listening auto-sends the transcript into the conversation", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalled());

    // User finishes speaking: stop listening → onstop → STT → auto-send.
    await act(async () => {
      screen.getByRole("button", { name: /stop listening/i }).click();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/ai-stt"),
        expect.anything(),
      );
      // The transcript appears as a sent user message, not in the input box.
      expect(screen.getByText(STT_TRANSCRIPT)).toBeTruthy();
    });
    const input = screen.getByPlaceholderText(/ask/i) as HTMLTextAreaElement;
    expect(input.value).toBe("");
  });

  it("exiting voice mode mid-capture discards the audio — no STT upload, no auto-send", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalled());

    // Exit voice mode while still listening (teardown stop).
    await act(async () => {
      screen.getByRole("button", { name: /exit voice mode/i }).click();
    });
    await settle();

    expect(recorderStop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/ai-stt"),
      expect.anything(),
    );
    // Nothing was sent and nothing landed in the input box.
    expect(screen.queryByText(STT_TRANSCRIPT)).toBeNull();
    const input = screen.getByPlaceholderText(/ask/i) as HTMLTextAreaElement;
    expect(input.value).toBe("");
  });

  it("unmounting mid-capture discards the audio — no STT upload is performed", async () => {
    const { unmount } = renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalled());

    unmount();
    // Let the queued onstop microtask run.
    await new Promise((r) => setTimeout(r, 50));

    expect(recorderStop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/ai-stt"),
      expect.anything(),
    );
  });

  it("dictation mic button still starts capture and fills the input (unchanged behavior)", async () => {
    renderPanel();
    await settle();

    const micBtn = screen.getByRole("button", { name: /dictate message/i });
    await act(async () => {
      micBtn.click();
    });

    await waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
      expect(recorderStart).toHaveBeenCalled();
    });
    // Voice mode must NOT have been toggled by dictation.
    expect(screen.getByRole("button", { name: /start voice conversation/i })).toBeTruthy();

    // Stop dictation: transcript lands in the input box, nothing is auto-sent.
    await act(async () => {
      screen.getByRole("button", { name: /stop listening/i }).click();
    });
    await waitFor(() => {
      const input = screen.getByPlaceholderText(/ask/i) as HTMLTextAreaElement;
      expect(input.value).toBe(STT_TRANSCRIPT);
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/ai-agent/stream"),
      expect.anything(),
    );
  });
});

describe("AiChatPanel — voice-mode entry with denied mic permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    const err = new Error("NotAllowedError");
    err.name = "NotAllowedError";
    stubMedia({ rejectWith: err });
  });

  it("shows the mic error banner and never reaches a listening state", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });

    await waitFor(() => {
      expect(
        screen.getByText(/microphone access is blocked/i),
      ).toBeTruthy();
    });
    expect(recorderStart).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /stop listening/i })).toBeNull();
  });
});
