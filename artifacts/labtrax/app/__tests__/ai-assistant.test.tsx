/**
 * Unit tests for ai-assistant.tsx.
 *
 * Invariants protected:
 *  Mic-button accessibilityLabel:
 *   - When the OS throws an error whose message contains "NotAllowed" /
 *     "Permission" / "permission" (permission denial), the mic button
 *     accessibilityLabel reads "Microphone blocked — tap to dismiss".
 *   - When recording fails for any other reason (device unavailable, generic
 *     OS error, etc.), the label reads "Microphone error — tap to dismiss".
 *
 *  dispatchAiStream (SSE streaming):
 *   - Tokens accumulate progressively in the assistant message bubble.
 *   - A proposed_action SSE event renders a ConfirmCard with Confirm / Cancel.
 *   - Tapping Confirm calls /api/ai-agent/confirm and transitions the card to "Done".
 *   - Tapping Cancel calls /api/ai-agent/reject and shows "Action cancelled".
 *   - Non-200 responses (503, 429, other) show the correct error text.
 *   - A null resp.body shows the generic "Something went wrong" error.
 */

import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
// dispatchAiStream uses `expo/fetch` (streaming fetch — RN's global fetch has
// no ReadableStream body on-device). vitest.setup mocks expo/fetch as a vi.fn
// routed through the shared fetchHandler; stream tests override it directly.
import { fetch as expoFetch } from "expo/fetch";
import { resetMockAppState, setMockFetchHandler, resetMockFetchHandler } from "../../vitest.setup";

const expoFetchMock = vi.mocked(expoFetch);

/** Queue a one-shot response for the next expo/fetch stream call. */
function mockStreamResponseOnce(resp: Response): void {
  expoFetchMock.mockResolvedValueOnce(
    resp as unknown as Awaited<ReturnType<typeof expoFetch>>,
  );
}

// ─── Hoisted mock factories ───────────────────────────────────────────────────
// vi.hoisted ensures the mock fns are available inside the vi.mock factories
// below (which are hoisted to the top of the file by Vitest).

const {
  mockRequestPermissionsAsync,
  mockSetAudioModeAsync,
  mockRecordingCreateAsync,
  mockSoundCreateAsync,
  mockSoundPlayAsync,
} = vi.hoisted(() => {
  const mockSoundPlayAsync = vi.fn(async () => undefined);
  return {
    mockRequestPermissionsAsync: vi.fn(async () => ({
      status: "granted",
      granted: true,
    })),
    mockSetAudioModeAsync: vi.fn(async () => undefined),
    mockRecordingCreateAsync: vi.fn(async () => ({
      recording: {
        stopAndUnloadAsync: vi.fn(async () => undefined),
        getURI: vi.fn(() => "file:///tmp/test.m4a"),
      },
    })),
    mockSoundPlayAsync,
    mockSoundCreateAsync: vi.fn(async () => ({
      sound: {
        setOnPlaybackStatusUpdate: vi.fn(),
        playAsync: mockSoundPlayAsync,
        stopAsync: vi.fn(async () => undefined),
        unloadAsync: vi.fn(async () => undefined),
      },
    })),
  };
});

vi.mock("expo-av", () => ({
  Audio: {
    requestPermissionsAsync: () => mockRequestPermissionsAsync(),
    setAudioModeAsync: () => mockSetAudioModeAsync(),
    Recording: {
      createAsync: () => mockRecordingCreateAsync(),
    },
    RecordingOptionsPresets: {
      HIGH_QUALITY: {},
    },
    Sound: {
      createAsync: (...args: unknown[]) => mockSoundCreateAsync(...(args as [])),
    },
  },
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => undefined),
  getStringAsync: vi.fn(async () => ""),
}));

// ─── Screen under test ────────────────────────────────────────────────────────

import AiAssistantScreen from "@/app/ai-assistant";

// ─── Test lifecycle ───────────────────────────────────────────────────────────

afterEach(async () => {
  cleanup();
  // The AsyncStorage mock store is module-level and otherwise persists across
  // tests in this file. Clear it so each test's mount effect sees a clean
  // local chat session (no leaked messages/proposed-action cards) and one
  // test's restored conversation never bleeds into the next test's restore.
  await AsyncStorage.clear();
  resetMockAppState();
  vi.clearAllMocks();
  // Restore default successful permission for subsequent tests.
  mockRequestPermissionsAsync.mockResolvedValue({ status: "granted", granted: true });
  mockRecordingCreateAsync.mockResolvedValue({
    recording: {
      stopAndUnloadAsync: vi.fn(async () => undefined),
      getURI: vi.fn(() => "file:///tmp/test.m4a"),
    },
  });
});

// ─── Mic button tests ─────────────────────────────────────────────────────────

describe("AiAssistantScreen — mic button accessibilityLabel on permission error", () => {
  it('label reads "Microphone blocked — tap to dismiss" when requestPermissionsAsync throws a NotAllowed error', async () => {
    const err = new Error("NotAllowed: mic permission denied");
    mockRequestPermissionsAsync.mockRejectedValueOnce(err);

    const { getByLabelText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const micBtn = getByLabelText("Dictate message");
    fireEvent.press(micBtn);

    await waitFor(() => {
      expect(
        getByLabelText("Microphone blocked — tap to dismiss"),
      ).toBeTruthy();
    });
  });

  it('label reads "Microphone blocked — tap to dismiss" when requestPermissionsAsync throws a Permission error', async () => {
    const err = new Error("Permission to use microphone was denied");
    mockRequestPermissionsAsync.mockRejectedValueOnce(err);

    const { getByLabelText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const micBtn = getByLabelText("Dictate message");
    fireEvent.press(micBtn);

    await waitFor(() => {
      expect(
        getByLabelText("Microphone blocked — tap to dismiss"),
      ).toBeTruthy();
    });
  });
});

describe("AiAssistantScreen — mic button accessibilityLabel on non-permission error", () => {
  it('label reads "Microphone error — tap to dismiss" when requestPermissionsAsync throws a generic error', async () => {
    const err = new Error("AVAudioSession could not be activated");
    mockRequestPermissionsAsync.mockRejectedValueOnce(err);

    const { getByLabelText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const micBtn = getByLabelText("Dictate message");
    fireEvent.press(micBtn);

    await waitFor(() => {
      expect(
        getByLabelText("Microphone error — tap to dismiss"),
      ).toBeTruthy();
    });
  });

  it('label reads "Microphone error — tap to dismiss" when Recording.createAsync throws after permissions are granted', async () => {
    mockRequestPermissionsAsync.mockResolvedValueOnce({
      status: "granted",
      granted: true,
    });
    mockRecordingCreateAsync.mockRejectedValueOnce(
      new Error("Hardware unavailable"),
    );

    const { getByLabelText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const micBtn = getByLabelText("Dictate message");
    fireEvent.press(micBtn);

    await waitFor(() => {
      expect(
        getByLabelText("Microphone error — tap to dismiss"),
      ).toBeTruthy();
    });
  });
});

// ─── SSE streaming helpers ────────────────────────────────────────────────────

/**
 * Build a ReadableStream that delivers the given SSE events as one UTF-8 chunk.
 * Each event is formatted as `data: <json>\n\n` so the parser in dispatchAiStream
 * (which splits on "\n") can parse it correctly.
 */
function makeSSEStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("\n");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

// ─── dispatchAiStream streaming tests ────────────────────────────────────────

describe("AiAssistantScreen — dispatchAiStream streaming", () => {
  afterEach(() => {
    // mockReset restores the original implementation given to vi.fn() in
    // vitest.setup (routing through the shared fetchHandler).
    expoFetchMock.mockReset();
    resetMockFetchHandler();
  });

  it("streams tokens into the assistant message bubble progressively", async () => {
    mockStreamResponseOnce(
      new Response(
        makeSSEStream([
          { token: "Hello" },
          { token: " world" },
          { done: true },
        ]),
        { status: 200 },
      ),
    );

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hi there");
    fireEvent.press(getByLabelText("Send message"));

    await findByText("Hello world");
  });

  it("renders a ConfirmCard with Confirm and Cancel buttons on proposed_action", async () => {
    mockStreamResponseOnce(
      new Response(
        makeSSEStream([
          {
            proposed_action: {
              actionId: "act-001",
              toolName: "create_case",
              summary: "Create a new case for Dr. Smith",
            },
          },
        ]),
        { status: 200 },
      ),
    );

    const { getByLabelText, getByPlaceholderText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "create a case");
    fireEvent.press(getByLabelText("Send message"));

    await waitFor(() => {
      expect(getByLabelText("Confirm action")).toBeTruthy();
      expect(getByLabelText("Cancel action")).toBeTruthy();
    });
  });

  it("calls /api/ai-agent/confirm and transitions the card to Done when Confirm is tapped", async () => {
    // Stream 1: proposed_action that shows the ConfirmCard
    mockStreamResponseOnce(
      new Response(
        makeSSEStream([
          {
            proposed_action: {
              actionId: "act-002",
              toolName: "create_case",
              summary: "Create case for Dr. Jones",
            },
          },
        ]),
        { status: 200 },
      ),
    );

    // Stream 2: follow-up reply dispatched after confirm succeeds
    mockStreamResponseOnce(
      new Response(
        makeSSEStream([{ token: "Case created." }, { done: true }]),
        { status: 200 },
      ),
    );

    // resilientFetch handler for the /api/ai-agent/confirm call — also records
    // whether the endpoint was actually called with the correct actionId.
    let confirmCalledWith: unknown = null;
    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/ai-agent/confirm")) {
        try {
          confirmCalledWith = JSON.parse(
            typeof init?.body === "string" ? init.body : "",
          );
        } catch { /* ignore */ }
        return new Response(
          JSON.stringify({
            type: "confirm_result",
            success: true,
            summary: "Case created successfully",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "create a case");
    fireEvent.press(getByLabelText("Send message"));

    await waitFor(() => {
      expect(getByLabelText("Confirm action")).toBeTruthy();
    });

    fireEvent.press(getByLabelText("Confirm action"));

    // The card state transitions to "done" → ConfirmCard renders the "Done" label
    await findByText("Done");

    // Verify the confirm endpoint was called with the correct actionId
    expect(confirmCalledWith).toMatchObject({ actionId: "act-002" });
  });

  it("calls /api/ai-agent/reject and shows Action cancelled when Cancel is tapped", async () => {
    mockStreamResponseOnce(
      new Response(
        makeSSEStream([
          {
            proposed_action: {
              actionId: "act-003",
              toolName: "delete_case",
              summary: "Delete case #123",
            },
          },
        ]),
        { status: 200 },
      ),
    );

    let rejectCalled = false;
    setMockFetchHandler(async (url) => {
      if (url.includes("/api/ai-agent/reject")) {
        rejectCalled = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "delete the case");
    fireEvent.press(getByLabelText("Send message"));

    await waitFor(() => {
      expect(getByLabelText("Cancel action")).toBeTruthy();
    });

    fireEvent.press(getByLabelText("Cancel action"));

    await findByText("Action cancelled");
    expect(rejectCalled).toBe(true);
  });

  it("shows the 503 error message when the stream endpoint returns 503", async () => {
    mockStreamResponseOnce(
      new Response("Service Unavailable", { status: 503 }),
    );

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText(
      "AI assistant is not configured on this server. Contact your administrator.",
    );
  });

  it("shows the server-provided error string on a 503 with a JSON body", async () => {
    mockStreamResponseOnce(
      new Response(
        JSON.stringify({
          error:
            "AI assistant is not configured on this server. Please ask your administrator to set AI_INTEGRATIONS_OPENAI_API_KEY.",
        }),
        { status: 503 },
      ),
    );

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText(
      "AI assistant is not configured on this server. Please ask your administrator to set AI_INTEGRATIONS_OPENAI_API_KEY.",
    );
  });

  it("shows the 429 rate-limit message when the stream endpoint returns 429", async () => {
    mockStreamResponseOnce(
      new Response("Too Many Requests", { status: 429 }),
    );

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText("Please slow down — try again in a moment.");
  });

  it("shows the server-error message for a 500 response", async () => {
    mockStreamResponseOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText(
      "The server hit an error while processing your request. Please try again.",
    );
  });

  it("shows the session-expired message when the stream endpoint returns 401", async () => {
    mockStreamResponseOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText(
      "Your session has expired. Please sign in again to keep using the AI assistant.",
    );
  });

  it("shows the no-permission message when the stream endpoint returns 403", async () => {
    mockStreamResponseOnce(
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    );

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText(
      "You don't have permission to use the AI assistant on this account.",
    );
  });

  it("shows the outdated-deployment message when the stream endpoint returns 404", async () => {
    mockStreamResponseOnce(new Response("Not Found", { status: 404 }));

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText(
      "This server doesn't have the AI assistant available — it may be running an outdated deployment. Please contact your administrator.",
    );
  });

  it("shows the network error message when the fetch itself rejects", async () => {
    expoFetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText(
      "Sorry, I'm having trouble connecting right now. Please check your connection and try again.",
    );
  });

  it("shows the interrupted message when resp.body is null", async () => {
    // Simulate a Response with body: null (can happen in some environments)
    const bodylessResp = { ok: true, status: 200, body: null } as unknown as Response;
    mockStreamResponseOnce(bodylessResp);

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText(
      "The AI response was interrupted before it finished. Please try again.",
    );
  });

  it("shows the interrupted message when the stream ends without a done event", async () => {
    // Stream that emits one malformed SSE line then closes with no terminal event.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {not json}\n\n"));
        controller.close();
      },
    });
    mockStreamResponseOnce(
      { ok: true, status: 200, body: stream } as unknown as Response,
    );

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText(
      "The AI response was interrupted before it finished. Please try again.",
    );
  });
});

// ─── Voice (speech-to-text) round-trip tests ─────────────────────────────────

/**
 * Mock XMLHttpRequest used by uploadAudioForTranscript. The module-level
 * uploadAudioForTranscript helper is not exported, so its behaviour is driven
 * by intercepting the XHR layer it depends on. Each test seeds `mockXhrState`
 * to control whether the STT request loads successfully (returning a transcript
 * JSON body) or fires its `onerror` handler (simulating a network failure).
 */
const { mockXhrState } = vi.hoisted(() => ({
  mockXhrState: {
    mode: "load" as "load" | "error",
    status: 200,
    responseText: JSON.stringify({ ok: true, transcript: "" }),
  },
}));

class MockXHR {
  status = 0;
  responseText = "";
  withCredentials = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    setTimeout(() => {
      if (mockXhrState.mode === "error") {
        this.onerror?.();
        return;
      }
      this.status = mockXhrState.status;
      this.responseText = mockXhrState.responseText;
      this.onload?.();
    }, 0);
  }
}

describe("AiAssistantScreen — voice (speech-to-text) round-trip", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let realXHR: typeof globalThis.XMLHttpRequest;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    // Clear recorded expo/fetch calls so "no stream dispatched" assertions
    // don't see calls leaked from earlier tests.
    expoFetchMock.mockClear();
    realXHR = globalThis.XMLHttpRequest;
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = MockXHR;
    // Reset to a successful load with an empty transcript; each test overrides.
    mockXhrState.mode = "load";
    mockXhrState.status = 200;
    mockXhrState.responseText = JSON.stringify({ ok: true, transcript: "" });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetMockFetchHandler();
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = realXHR;
  });

  /** Drives the record → stop → STT chain: presses mic, waits for the
   *  "listening" state, then presses again to stop and trigger transcription. */
  async function recordAndStop(
    getByLabelText: (label: string) => unknown,
  ): Promise<void> {
    fireEvent.press(getByLabelText("Dictate message") as Parameters<typeof fireEvent.press>[0]);
    await waitFor(() => {
      expect(getByLabelText("Stop recording")).toBeTruthy();
    });
    fireEvent.press(getByLabelText("Stop recording") as Parameters<typeof fireEvent.press>[0]);
  }

  it("transcribes recorded audio and fills the text input", async () => {
    mockXhrState.responseText = JSON.stringify({
      ok: true,
      transcript: "show me overdue cases",
    });

    const { getByLabelText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await recordAndStop(getByLabelText);

    // The transcript is placed in the text input, not auto-sent.
    await waitFor(() => {
      expect(getByLabelText("Dictate message")).toBeTruthy();
    });

    // No stream request was dispatched automatically.
    const streamCall = expoFetchMock.mock.calls.find(([url]: unknown[]) =>
      String(url).includes("/api/ai-agent/stream"),
    );
    expect(streamCall).toBeUndefined();
  });

  it("does not send a message when the transcript is empty", async () => {
    mockXhrState.responseText = JSON.stringify({ ok: true, transcript: "   " });

    const { getByLabelText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await recordAndStop(getByLabelText);

    // The mic returns to its idle label without dispatching a stream request.
    await waitFor(() => {
      expect(getByLabelText("Dictate message")).toBeTruthy();
    });
    const streamCall = expoFetchMock.mock.calls.find(([url]: unknown[]) =>
      String(url).includes("/api/ai-agent/stream"),
    );
    expect(streamCall).toBeUndefined();
  });

  it("shows the transcription error state when the STT request fails", async () => {
    mockXhrState.mode = "error";

    const { getByLabelText, findByText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await recordAndStop(getByLabelText);

    // The error banner text and the mic error label both surface.
    await findByText("Network error");
    await waitFor(() => {
      expect(getByLabelText("Microphone error — tap to dismiss")).toBeTruthy();
    });

    // No stream request was dispatched.
    const streamCall = expoFetchMock.mock.calls.find(([url]: unknown[]) =>
      String(url).includes("/api/ai-agent/stream"),
    );
    expect(streamCall).toBeUndefined();
  });

  it("shows the transcription error state when STT returns a non-200 status", async () => {
    mockXhrState.status = 500;
    mockXhrState.responseText = JSON.stringify({ ok: false });

    const { getByLabelText, findByText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await recordAndStop(getByLabelText);

    await findByText("STT failed");
    await waitFor(() => {
      expect(getByLabelText("Microphone error — tap to dismiss")).toBeTruthy();
    });
  });
});

// ─── Voice conversation TTS (text-to-speech) tests ───────────────────────────
//
// Protects the "Maynard speaks his replies" flow: after a conversation-mode
// voice exchange, the reply is fetched from /api/ai-tts via expo/fetch (the
// only fetch path proven to stream/download reliably on physical devices),
// written to a temp file, and played with expo-av. A TTS failure must surface
// the visible voice-playback error banner instead of failing silently.

describe("AiAssistantScreen — voice conversation TTS", () => {
  let realXHR: typeof globalThis.XMLHttpRequest;

  beforeEach(() => {
    expoFetchMock.mockClear();
    realXHR = globalThis.XMLHttpRequest;
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = MockXHR;
    mockXhrState.mode = "load";
    mockXhrState.status = 200;
    mockXhrState.responseText = JSON.stringify({ ok: true, transcript: "hello maynard" });
  });

  afterEach(() => {
    resetMockFetchHandler();
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = realXHR;
  });

  /** Routes the SSE stream + TTS endpoints; everything else gets the default body. */
  function installConversationHandler(opts: { ttsStatus: number }): { ttsCalls: string[] } {
    const ttsCalls: string[] = [];
    setMockFetchHandler(async (url: string) => {
      if (url.includes("/api/ai-agent/stream")) {
        return new Response(
          makeSSEStream([{ token: "Hi there!" }, { done: true }]),
          { status: 200 },
        );
      }
      if (url.includes("/api/ai-tts")) {
        ttsCalls.push(url);
        if (opts.ttsStatus !== 200) {
          return new Response(JSON.stringify({ ok: false }), { status: opts.ttsStatus });
        }
        return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    return { ttsCalls };
  }

  /** Presses the headset (conversation) button, records, then stops. */
  async function conversationRecordAndStop(
    getByLabelText: (label: string) => unknown,
  ): Promise<void> {
    fireEvent.press(getByLabelText("Talk with Maynard") as Parameters<typeof fireEvent.press>[0]);
    await waitFor(() => {
      expect(getByLabelText("Stop recording")).toBeTruthy();
    });
    fireEvent.press(getByLabelText("Talk with Maynard") as Parameters<typeof fireEvent.press>[0]);
  }

  it("speaks the reply after a conversation-mode voice exchange", async () => {
    const { ttsCalls } = installConversationHandler({ ttsStatus: 200 });

    const { getByLabelText, findByText } = render(<AiAssistantScreen />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await conversationRecordAndStop(getByLabelText);

    // The streamed reply renders…
    await findByText("Hi there!");

    // …and the TTS pipeline runs: /api/ai-tts fetched, audio written, played.
    await waitFor(() => {
      expect(ttsCalls.length).toBe(1);
    });
    const FileSystem = await import("expo-file-system/legacy");
    await waitFor(() => {
      expect(vi.mocked(FileSystem.writeAsStringAsync)).toHaveBeenCalledWith(
        expect.stringContaining("tts-"),
        expect.any(String),
        expect.objectContaining({ encoding: "base64" }),
      );
      expect(mockSoundCreateAsync).toHaveBeenCalled();
      expect(mockSoundPlayAsync).toHaveBeenCalled();
    });
  });

  it("shows the voice playback error banner when the TTS request fails", async () => {
    const { ttsCalls } = installConversationHandler({ ttsStatus: 500 });

    const { getByLabelText, findByText } = render(<AiAssistantScreen />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await conversationRecordAndStop(getByLabelText);

    await findByText("Hi there!");
    await waitFor(() => {
      expect(ttsCalls.length).toBe(1);
    });

    // The failure is surfaced, not swallowed.
    await findByText(
      "Maynard couldn't speak that reply. Check your volume, then tap the headset button to try again.",
    );
    expect(mockSoundCreateAsync).not.toHaveBeenCalled();
  });
});

// ─── Server-history fallback tests ────────────────────────────────────────────

describe("AiAssistantScreen — server-history fallback on mount", () => {
  afterEach(() => {
    resetMockFetchHandler();
  });

  it("seeds the conversation from /api/ai-chat/history when no local session exists", async () => {
    setMockFetchHandler(async (url) => {
      if (url.includes("/api/ai-chat/history")) {
        return new Response(
          JSON.stringify({
            messages: [
              { id: "srv-1", role: "user", content: "What cases are due today?" },
              { id: "srv-2", role: "assistant", content: "You have three cases due today." },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { findByText, findAllByText } = render(<AiAssistantScreen />);

    // The assistant reply is unique to the chat thread. The user message text
    // also appears as the "Past Conversations" session preview (the restored
    // history is persisted as a resumable session), so allow multiple matches.
    await findByText("You have three cases due today.");
    const userMsgs = await findAllByText("What cases are due today?");
    expect(userMsgs.length).toBeGreaterThan(0);
  });

  it("leaves the welcome message when the server has no history", async () => {
    setMockFetchHandler(async (url) => {
      if (url.includes("/api/ai-chat/history")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { findByText } = render(<AiAssistantScreen />);

    // The welcome greeting remains the only assistant message.
    await findByText(/I'm Maynard/i);
  });

  it("falls back to the welcome message when the history request fails", async () => {
    setMockFetchHandler(async (url) => {
      if (url.includes("/api/ai-chat/history")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { findByText } = render(<AiAssistantScreen />);

    await findByText(/I'm Maynard/i);
  });
});

// ─── "Load earlier messages" pagination tests ─────────────────────────────────

describe("AiAssistantScreen — load earlier messages", () => {
  afterEach(() => {
    resetMockFetchHandler();
  });

  // NOTE: assertions target assistant-role messages. The "Past Conversations"
  // session preview renders the first *user* message of each stored session, so
  // user-message text appears twice (chat thread + preview). Assistant messages
  // appear only in the chat thread, making them unambiguous to assert on.
  it("prepends the older page above existing messages when the button is tapped", async () => {
    // Mount load (no `before`) returns the newest page with more older rows.
    // The "load earlier" load (`before=` present) returns the older page.
    setMockFetchHandler(async (url) => {
      if (url.includes("/api/ai-chat/history")) {
        if (url.includes("before=")) {
          return new Response(
            JSON.stringify({
              messages: [
                { id: "m1", role: "user", content: "older question" },
                { id: "m2", role: "assistant", content: "older answer" },
              ],
              hasMore: false,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            messages: [
              { id: "m3", role: "user", content: "newest question" },
              { id: "m4", role: "assistant", content: "newest answer" },
            ],
            hasMore: true,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { findByText, queryByText } = render(<AiAssistantScreen />);

    // The newest page is shown and the affordance appears (hasMore: true).
    await findByText("newest answer");
    const loadBtn = await findByText("Load earlier messages");

    fireEvent.press(loadBtn);

    // Older messages are fetched and prepended.
    await findByText("older answer");

    // hasMore=false on the older page hides the affordance.
    await waitFor(() => {
      expect(queryByText("Load earlier messages")).toBeNull();
    });
  });

  it("de-duplicates older rows by id so an echoed boundary row is not shown twice", async () => {
    // The boundary row "dup" is an assistant message present at the top of the
    // newest page AND the bottom of the older page. After prepend it must appear
    // exactly once.
    setMockFetchHandler(async (url) => {
      if (url.includes("/api/ai-chat/history")) {
        if (url.includes("before=")) {
          return new Response(
            JSON.stringify({
              messages: [
                { id: "m1", role: "user", content: "genuinely older" },
                { id: "m0", role: "assistant", content: "older marker" },
                { id: "dup", role: "assistant", content: "shared boundary message" },
              ],
              hasMore: false,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            messages: [
              { id: "dup", role: "assistant", content: "shared boundary message" },
              { id: "m3", role: "user", content: "newest question" },
            ],
            hasMore: true,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const { findByText, findAllByText } = render(<AiAssistantScreen />);

    const loadBtn = await findByText("Load earlier messages");
    fireEvent.press(loadBtn);

    // The older page has been prepended (its unique marker is visible).
    await findByText("older marker");

    // The boundary message appears exactly once in the chat thread despite being
    // present in both the newest and the older page.
    await waitFor(async () => {
      const nodes = await findAllByText("shared boundary message");
      expect(nodes).toHaveLength(1);
    });
  });
});
