/** @vitest-environment jsdom */
/**
 * Regression tests for the LabTrax Assistant voice-conversation (headphones) button.
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

import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
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
const STT_TRANSCRIPT = "hello assistant";

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

// ─── TTS / playback stubs (spoken-reply tests) ────────────────────────────────
//
// jsdom does not implement HTMLMediaElement playback (`play()`/`pause()` are
// no-ops or throw "not implemented") nor `URL.createObjectURL`, so speakText's
// happy and failure paths can't be exercised against the real globals. These
// tests replace `window.Audio` with a fully-controllable fake and stub the
// Blob URL helpers, mirroring the `URL.createObjectURL` stubbing pattern used
// by AuthedMedia.attachment.test.tsx / UnassignedDocumentsCard.preview.test.tsx.

const ASSISTANT_REPLY = "Here is the answer to your question.";

/** Controls how the stubbed /ai-tts endpoint responds; reset per test. */
let ttsMode: "success" | "http-error" | "empty-audio" | "network-error" = "success";

/** Every FakeAudio the component constructs during a test, most-recent last. */
let audioInstances: FakeAudio[] = [];
/** Controls what `audio.play()` resolves/rejects with; reassigned per test. */
let audioPlayMock = vi.fn();

class FakeAudio {
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src: string) {
    this.src = src;
    audioInstances.push(this);
  }
  play() {
    return audioPlayMock();
  }
  pause() {}
}

/** Encode SSE event objects the way /ai-agent/stream does on the wire. */
function encodeSseEvents(events: Record<string, unknown>[]): Uint8Array {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new TextEncoder().encode(text);
}

/**
 * Layers streaming (/ai-agent/stream) and TTS (/ai-tts) handling on top of
 * stubMedia()'s /ai-stt stub, and installs the FakeAudio class. Call after
 * stubMedia() so getUserMedia/MediaRecorder are also stubbed.
 */
function stubAiReplyAndTts() {
  audioInstances = [];
  audioPlayMock = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { Audio: unknown }).Audio = FakeAudio;
  (globalThis as unknown as { Audio: unknown }).Audio = FakeAudio;

  fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/ai-stt")) {
      return new Response(JSON.stringify({ ok: true, transcript: STT_TRANSCRIPT }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/ai-agent/stream")) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encodeSseEvents([{ token: ASSISTANT_REPLY }, { done: true }]));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (u.includes("/ai-tts")) {
      if (ttsMode === "network-error") throw new Error("network down");
      if (ttsMode === "http-error") {
        return new Response(JSON.stringify({ ok: false, error: "Voice playback is temporarily unavailable." }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      // NOTE: pass raw bytes (Uint8Array), not a Blob, as the Response body.
      // Constructing `new Response(new Blob([...]), ...)` in this jsdom+undici
      // setup silently stringifies the Blob to the literal text "[object
      // Blob]" (a cross-realm `instanceof Blob` check inside undici's Response
      // fails), which the component's `resp.blob()` then reads back as a
      // *non-empty* 13-byte blob — the opposite of what "empty-audio" means
      // to test. A raw Uint8Array body has no such ambiguity.
      const bytes = ttsMode === "empty-audio" ? [] : [1, 2, 3];
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }
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
    expect(screen.getByText(/Listening/i)).toBeTruthy();
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

describe("AiChatPanel — remembered voice mode resumes only on a user gesture", () => {
  const VOICE_PREFS_KEY = "labtrax_ai_voice_prefs_v1";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify({ voiceMode: true, ttsVoice: "onyx" }));
    stubMedia();
  });

  it("mounting with remembered voice mode never starts mic capture and shows the resume affordance", async () => {
    renderPanel();
    await settle();

    // No mic capture without a user gesture.
    expect(getUserMediaMock).not.toHaveBeenCalled();
    expect(recorderStart).not.toHaveBeenCalled();

    // Clear "tap to resume" affordance instead of a silent half-on state.
    expect(screen.getByRole("button", { name: /resume voice conversation/i })).toBeTruthy();
    expect(
      screen.getByText(/voice mode remembered — tap the headphones to resume/i),
    ).toBeTruthy();
  });

  it("first click on the headphones resumes the full loop (mic starts, voice mode stays on)", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /resume voice conversation/i }).click();
    });

    await waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
      expect(recorderStart).toHaveBeenCalled();
    });

    // Voice mode was NOT toggled off — the button now reads "Exit voice mode".
    expect(screen.getByRole("button", { name: /exit voice mode/i })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /stop listening/i })).toBeTruthy();
    });
    expect(screen.queryByText(/voice mode remembered/i)).toBeNull();
  });

  it("after resuming, stopping listening auto-sends the transcript (loop continues)", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /resume voice conversation/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalled());

    await act(async () => {
      screen.getByRole("button", { name: /stop listening/i }).click();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/ai-stt"),
        expect.anything(),
      );
      expect(screen.getByText(STT_TRANSCRIPT)).toBeTruthy();
    });
  });

  it("declining the resume via 'turn off' never starts mic capture and persists voice mode off", async () => {
    renderPanel();
    await settle();

    // The one-action decline affordance is visible alongside the resume hint.
    const turnOffBtn = screen.getByRole("button", { name: /turn voice mode off/i });
    await act(async () => {
      turnOffBtn.click();
    });
    await settle();

    // No mic capture ever happened — getUserMedia was never called.
    expect(getUserMediaMock).not.toHaveBeenCalled();
    expect(recorderStart).not.toHaveBeenCalled();

    // Voice mode is off: headphones button is back to its "start" state and
    // the resume affordance is gone.
    expect(screen.getByRole("button", { name: /start voice conversation/i })).toBeTruthy();
    expect(screen.queryByText(/voice mode remembered/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /turn voice mode off/i })).toBeNull();

    // Preference persisted as off, so the next open starts clean.
    const prefs = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) ?? "{}") as {
      voiceMode?: boolean;
    };
    expect(prefs.voiceMode).toBe(false);
  });

  it("dictation click while resume is pending also clears the affordance", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /dictate message/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalled());

    await waitFor(() => {
      expect(screen.queryByText(/voice mode remembered/i)).toBeNull();
      // The gesture happened, so voice mode is now fully active.
      expect(screen.getByRole("button", { name: /exit voice mode/i })).toBeTruthy();
    });
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
    expect(screen.getByText(/Error — microphone unavailable/i)).toBeTruthy();
    expect(recorderStart).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /stop listening/i })).toBeNull();
  });
});

// ─── Spoken-reply playback (speakText) ────────────────────────────────────────
//
// Regression tests for the desktop TTS-playback fix: previously speakText
// swallowed every failure (non-OK /ai-tts response, no audio returned, or a
// browser audio.play() error) by silently flipping isSpeaking back to false,
// so the auto-listen effect reopened the mic as if a reply had actually been
// spoken. Mirrors the equivalent mobile AiChatPanel speakErrorMsg coverage.

describe("AiChatPanel — spoken replies in voice mode (TTS playback)", () => {
  let origCreateObjectURL: typeof URL.createObjectURL;
  let origRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    ttsMode = "success";
    stubMedia();
    stubAiReplyAndTts();
    origCreateObjectURL = URL.createObjectURL;
    origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-tts-audio") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
  });

  /** Enter voice mode, speak a phrase, and let the reply stream to completion. */
  async function speakInVoiceMode() {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalled());

    await act(async () => {
      screen.getByRole("button", { name: /stop listening/i }).click();
    });

    await waitFor(
      () => {
        expect(screen.getByText(ASSISTANT_REPLY)).toBeTruthy();
      },
      { timeout: 3000 },
    );
  }

  it("a completed assistant reply triggers speech (calls /ai-tts) in voice mode", async () => {
    await speakInVoiceMode();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/ai-tts"),
        expect.objectContaining({
          body: JSON.stringify({ text: ASSISTANT_REPLY, voice: "alloy" }),
        }),
      );
    });
    await waitFor(() => expect(audioPlayMock).toHaveBeenCalled());
    expect(screen.getByText(/Speaking — LabTrax Assistant is speaking/i)).toBeTruthy();
    expect(screen.queryByText(/couldn.t speak/i)).toBeNull();
  });

  it("resumes listening automatically once the spoken reply finishes playing", async () => {
    await speakInVoiceMode();
    await waitFor(() => expect(audioPlayMock).toHaveBeenCalled());

    // Simulate the browser finishing playback of the reply.
    await act(async () => {
      audioInstances[audioInstances.length - 1]?.onended?.();
    });

    await waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalledTimes(2);
      expect(recorderStart).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText(/couldn.t speak/i)).toBeNull();
  });

  it("a failed /ai-tts response shows a warning and does not resume listening", async () => {
    ttsMode = "http-error";
    await speakInVoiceMode();

    await waitFor(() => {
      expect(screen.getByText(/couldn.t speak that reply/i)).toBeTruthy();
    });
    // Give the (buggy, pre-fix) auto-listen path a chance to fire before asserting.
    await settle();

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /stop listening/i })).toBeNull();

    // Dismissable, and typed chat is unaffected.
    await act(async () => {
      screen.getByRole("button", { name: /dismiss voice playback error/i }).click();
    });
    expect(screen.queryByText(/couldn.t speak that reply/i)).toBeNull();
  });

  it("a response with no audio returned shows a warning and does not resume listening", async () => {
    ttsMode = "empty-audio";
    await speakInVoiceMode();

    await waitFor(() => {
      expect(screen.getByText(/couldn.t speak that reply/i)).toBeTruthy();
    });
    await settle();

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /stop listening/i })).toBeNull();
  });

  it("a failed audio playback (browser can't play it) shows a warning and does not resume listening", async () => {
    audioPlayMock.mockRejectedValueOnce(new Error("NotSupportedError"));
    await speakInVoiceMode();

    await waitFor(() => {
      expect(screen.getByText(/couldn.t speak that reply/i)).toBeTruthy();
    });
    await settle();

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /stop listening/i })).toBeNull();
  });

  it("typed chat still works and is unaffected by a TTS playback failure", async () => {
    ttsMode = "http-error";
    renderPanel();
    await settle();

    // Voice mode is off — typing and sending a message must not touch /ai-tts
    // or show the playback banner.
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Hi Assistant" } });
    await act(async () => {
      screen.getByRole("button", { name: /send message/i }).click();
    });

    await waitFor(() => {
      expect(screen.getByText(ASSISTANT_REPLY)).toBeTruthy();
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/ai-tts"),
      expect.anything(),
    );
    expect(screen.queryByText(/couldn.t speak/i)).toBeNull();
  });
});

// ─── Voice sample preview ──────────────────────────────────────────────────────
//
// Locks in that the per-voice preview speaks as LabTrax Assistant in
// the first person and previews the
// specific voice whose Play button was clicked.

describe("AiChatPanel — per-voice sample preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    ttsMode = "success";
    stubMedia();
    stubAiReplyAndTts();
  });

  it("previews the clicked voice with first-person assistant phrasing", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /assistant voice/i }).click();
    });

    const coralOption = await screen.findByText(/coral/i);
    const playBtn = coralOption
      .closest('[role="option"]')!
      .querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    expect(playBtn).toBeTruthy();

    await act(async () => {
      playBtn.click();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/ai-tts"),
        expect.objectContaining({
          body: JSON.stringify({ text: "Hi, I'm LabTrax Assistant.", voice: "coral" }),
        }),
      );
    });

    const ttsCall = fetchMock.mock.calls.find(([u]: [unknown]) => String(u).includes("/ai-tts")) as
      | [unknown, RequestInit]
      | undefined;
    const parsedBody = JSON.parse(ttsCall?.[1]?.body as string) as { text: string; voice: string };
    expect(parsedBody.text).toBe("Hi, I'm LabTrax Assistant.");
    expect(parsedBody.text.toLowerCase()).not.toContain("retired assistant");
    expect(parsedBody.voice).toBe("coral");
  });
});

// ─── Composer layout ──────────────────────────────────────────────────────────
//
// The message box used to share a single row with the mic / headphone / voice
// picker / send controls, which squeezed it to one line and wrapped the
// placeholder onto three lines. It now owns a full-width row of its own with
// the controls on a second row beneath it.

describe("AiChatPanel — two-row composer layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    stubMedia();
  });

  it("puts the message box on its own full-width row above the control row", async () => {
    renderPanel();
    await settle();

    const textarea = screen.getByPlaceholderText(/ask/i) as HTMLTextAreaElement;
    const composer = screen.getByTestId("ai-composer");
    const controls = screen.getByTestId("ai-composer-controls");

    // The box is a direct child of the composer, not of the control row.
    expect(textarea.parentElement).toBe(composer);
    expect(controls.contains(textarea)).toBe(false);

    // Full width, roughly three lines tall by default, capped with internal
    // scrolling so a long message never pushes the conversation off screen.
    expect(textarea.rows).toBe(3);
    expect(textarea.className).toContain("w-full");
    expect(textarea.className).toContain("max-h-");
    expect(textarea.className).toContain("overflow-y-auto");
  });

  it("keeps the mic, headphone, voice-picker and send controls together on the row below", async () => {
    renderPanel();
    await settle();

    const controls = screen.getByTestId("ai-composer-controls");
    for (const name of [
      /dictate message/i,
      /start voice conversation/i,
      /assistant voice/i,
      /send message/i,
    ]) {
      const btn = screen.getByRole("button", { name });
      expect(controls.contains(btn)).toBe(true);
    }
  });
});

// ─── Persistent voice conversation ────────────────────────────────────────────
//
// Voice mode used to give up after a fixed 5 s of silence: it tore down
// listening and showed "No speech detected — click the headphone button to
// resume", so every pause to think cost the user a click. The conversation now
// stays armed through arbitrarily long pauses; the capture is recycled onto the
// same live microphone stream (so buffers stay bounded, no silence is uploaded
// for transcription, and the browser mic indicator never flickers) and only an
// explicit toggle-off, unmount, or a genuine failure ends the session.

/** Current simulated microphone level fed to the stubbed VAD analyser. */
let vadLevel = 0;
/** Pending requestAnimationFrame callbacks, drained by tickVad(). */
let rafQueue: FrameRequestCallback[] = [];

function stubVadEnvironment() {
  vadLevel = 0;
  rafQueue = [];

  class FakeAnalyser {
    fftSize = 512;
    frequencyBinCount = 256;
    getByteTimeDomainData(buf: Uint8Array) {
      // rms = vadLevel / 128 → 0 is silence, 40 is well above the speech gate.
      buf.fill(128 + vadLevel);
    }
  }
  class FakeAudioContext {
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    createAnalyser() {
      return new FakeAnalyser();
    }
    close() {}
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  // Assigned directly (not via stubGlobal) so afterEach can hand the real jsdom
  // implementations back: unstubbing interacts badly with the fake clock, which
  // also installs its own requestAnimationFrame/cancelAnimationFrame.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    rafQueue.push(cb)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
}

/** Run one frame of the VAD loop at the current (fake) clock time. */
function tickVad() {
  const queued = rafQueue;
  rafQueue = [];
  for (const cb of queued) cb(Date.now());
}

describe("AiChatPanel — voice conversation stays open through silence", () => {
  let origRaf: typeof requestAnimationFrame;
  let origCaf: typeof cancelAnimationFrame;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    stubMedia();
    origRaf = globalThis.requestAnimationFrame;
    origCaf = globalThis.cancelAnimationFrame;
    // Fake timers must be installed BEFORE the RAF stub: vitest's fake clock
    // also fakes requestAnimationFrame, which would otherwise swallow the VAD
    // loop instead of queueing it for tickVad().
    vi.useFakeTimers();
    stubVadEnvironment();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
  });

  /** settle() equivalent that works under fake timers. */
  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Render, turn voice mode on, and wait for the first capture to be armed. */
  async function enterVoiceMode() {
    renderPanel();
    await flush(50);
    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await flush(0);
    expect(recorderStart).toHaveBeenCalledTimes(1);
    // The VAD loop is running (AudioContext stub in place).
    expect(rafQueue.length).toBe(1);
  }

  /** Advance the clock through `ms` of silence, ticking the VAD loop as it goes. */
  async function stayQuiet(ms: number) {
    const STEP = 1000;
    for (let elapsed = 0; elapsed < ms; elapsed += STEP) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STEP);
        tickVad();
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  }

  it("stays listening through a long silence — no teardown, no 'No speech detected' banner", async () => {
    await enterVoiceMode();

    await stayQuiet(60000);

    expect(screen.queryByText(/no speech detected/i)).toBeNull();
    expect(screen.getByRole("button", { name: /stop listening/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /exit voice mode/i })).toBeTruthy();
    expect(screen.getByText(/still listening, take your time/i)).toBeTruthy();
  });

  it("recycles the capture during silence without uploading silence or releasing the mic", async () => {
    await enterVoiceMode();

    await stayQuiet(60000);

    // Capture was recycled at least once (buffers stay bounded)…
    expect(recorderStop.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(recorderStart.mock.calls.length).toBeGreaterThan(1);
    // …but no silence was ever sent for transcription…
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/ai-stt"),
      expect.anything(),
    );
    // …and the microphone stream was never released or re-acquired.
    expect(trackStop).not.toHaveBeenCalled();
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it("still captures and transcribes an utterance that comes after a long silence", async () => {
    await enterVoiceMode();
    await stayQuiet(60000);

    // The user finally speaks…
    vadLevel = 40;
    await act(async () => {
      tickVad();
      await vi.advanceTimersByTimeAsync(0);
    });
    // …then stops: end-of-utterance silence closes the turn and triggers STT.
    vadLevel = 0;
    await act(async () => {
      tickVad();
      await vi.advanceTimersByTimeAsync(2000);
      tickVad();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Fake timers are installed, so drive the async STT → send flow forward
    // explicitly rather than through waitFor's real-timer polling.
    await flush(200);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/ai-stt"),
      expect.anything(),
    );
    expect(screen.getByText(STT_TRANSCRIPT)).toBeTruthy();
  });

  it("still ends the conversation when the user toggles voice mode off after a silence", async () => {
    await enterVoiceMode();
    await stayQuiet(60000);

    await act(async () => {
      screen.getByRole("button", { name: /exit voice mode/i }).click();
    });
    await flush(50);

    expect(trackStop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /start voice conversation/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop listening/i })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/ai-stt"),
      expect.anything(),
    );
  });

  it("still releases the microphone when the panel is closed after a silence", async () => {
    const { unmount } = renderPanel();
    await flush(50);
    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await flush(0);

    await stayQuiet(30000);
    expect(trackStop).not.toHaveBeenCalled();

    unmount();
    await flush(50);

    expect(recorderStop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/ai-stt"),
      expect.anything(),
    );
  });
});

describe("AiChatPanel — re-arms after a turn with no speech in it", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    stubMedia();
    // /ai-stt returns an empty transcript for this suite: the captured turn
    // had no words in it.
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/ai-stt")) {
        return new Response(JSON.stringify({ ok: true, transcript: "   " }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("an empty transcript returns to listening instead of dropping to idle", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByRole("button", { name: /stop listening/i }).click();
    });

    await waitFor(() => {
      expect(recorderStart).toHaveBeenCalledTimes(2);
      expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole("button", { name: /stop listening/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /exit voice mode/i })).toBeTruthy();
    expect(screen.queryByText(/no speech detected/i)).toBeNull();
  });

  it("dictation with an empty transcript stays idle (voice mode off)", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /dictate message/i }).click();
    });
    await waitFor(() => expect(recorderStart).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByRole("button", { name: /stop listening/i }).click();
    });
    await settle();

    expect(recorderStart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /dictate message/i })).toBeTruthy();
  });
});

// ─── Teardown while the permission prompt is still open ───────────────────────
//
// getUserMedia() can resolve long after it was called (the browser may be
// showing a permission prompt, or the device may be slow to open). If the user
// turns voice mode off — or closes the assistant — in that window, the pending
// continuation must not quietly open the microphone behind them.

describe("AiChatPanel — teardown while the microphone request is still pending", () => {
  let releaseStream: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    stubMedia();
    // getUserMedia hangs until the test calls releaseStream().
    const fakeStream = { getTracks: () => [{ stop: trackStop }] };
    getUserMediaMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStream = () => resolve(fakeStream);
        }),
    );
  });

  it("turning voice mode off before permission resolves never opens the mic", async () => {
    renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await settle();
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(recorderStart).not.toHaveBeenCalled();

    // User gives up and exits voice mode while the prompt is still open…
    await act(async () => {
      screen.getByRole("button", { name: /exit voice mode/i }).click();
    });
    await settle();

    // …then the browser finally grants access.
    await act(async () => {
      releaseStream();
    });
    await settle();

    expect(recorderStart).not.toHaveBeenCalled();
    // The tracks handed to the stale continuation were released immediately.
    expect(trackStop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /start voice conversation/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop listening/i })).toBeNull();
  });

  it("closing the assistant before permission resolves never opens the mic", async () => {
    const { unmount } = renderPanel();
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: /start voice conversation/i }).click();
    });
    await settle();
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      releaseStream();
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(recorderStart).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });
});
