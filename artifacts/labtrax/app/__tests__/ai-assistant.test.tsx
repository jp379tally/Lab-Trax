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
import { resetMockAppState, setMockFetchHandler, resetMockFetchHandler } from "../../vitest.setup";

// ─── Hoisted mock factories ───────────────────────────────────────────────────
// vi.hoisted ensures the mock fns are available inside the vi.mock factories
// below (which are hoisted to the top of the file by Vitest).

const { mockRequestPermissionsAsync, mockSetAudioModeAsync, mockRecordingCreateAsync } =
  vi.hoisted(() => ({
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
  }));

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
      createAsync: vi.fn(async () => ({
        sound: {
          setOnPlaybackStatusUpdate: vi.fn(),
          playAsync: vi.fn(async () => undefined),
          unloadAsync: vi.fn(async () => undefined),
        },
      })),
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
  resetMockAppState();
  // Persisted chat sessions live in the mocked AsyncStorage, which is a
  // module-level Map shared across tests in this file. Clear it so one test's
  // restored conversation never bleeds into the next test's mount-time restore.
  await AsyncStorage.clear();
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

    const micBtn = getByLabelText("Speak to Maynard");
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

    const micBtn = getByLabelText("Speak to Maynard");
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

    const micBtn = getByLabelText("Speak to Maynard");
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

    const micBtn = getByLabelText("Speak to Maynard");
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
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetMockFetchHandler();
  });

  it("streams tokens into the assistant message bubble progressively", async () => {
    fetchSpy.mockResolvedValueOnce(
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
    fetchSpy.mockResolvedValueOnce(
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
    fetchSpy.mockResolvedValueOnce(
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
    fetchSpy.mockResolvedValueOnce(
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
    fetchSpy.mockResolvedValueOnce(
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
    fetchSpy.mockResolvedValueOnce(
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
      "AI assistant is not set up on this server. Contact your administrator.",
    );
  });

  it("shows the 429 rate-limit message when the stream endpoint returns 429", async () => {
    fetchSpy.mockResolvedValueOnce(
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

  it("shows a generic error message for other non-200 responses (e.g. 500)", async () => {
    fetchSpy.mockResolvedValueOnce(
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

    await findByText("Something went wrong. Please try again.");
  });

  it("shows a generic error message when resp.body is null", async () => {
    // Simulate a Response with body: null (can happen in some environments)
    const bodylessResp = { ok: true, status: 200, body: null } as unknown as Response;
    fetchSpy.mockResolvedValueOnce(bodylessResp);

    const { getByLabelText, getByPlaceholderText, findByText } = render(
      <AiAssistantScreen />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.changeText(getByPlaceholderText("Ask me anything…"), "hello");
    fireEvent.press(getByLabelText("Send message"));

    await findByText("Something went wrong. Please try again.");
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
    fireEvent.press(getByLabelText("Speak to Maynard") as Parameters<typeof fireEvent.press>[0]);
    await waitFor(() => {
      expect(getByLabelText("Stop recording")).toBeTruthy();
    });
    fireEvent.press(getByLabelText("Stop recording") as Parameters<typeof fireEvent.press>[0]);
  }

  it("transcribes recorded audio and sends it as a message through the AI stream", async () => {
    mockXhrState.responseText = JSON.stringify({
      ok: true,
      transcript: "show me overdue cases",
    });

    // SSE reply dispatched after the transcript is sent.
    fetchSpy.mockResolvedValueOnce(
      new Response(
        makeSSEStream([{ token: "Here are your overdue cases." }, { done: true }]),
        { status: 200 },
      ),
    );

    const { getByLabelText, findByText } = render(<AiAssistantScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await recordAndStop(getByLabelText);

    // The transcript is rendered as the user's message …
    await findByText("show me overdue cases");
    // … and the AI streamed reply follows.
    await findByText("Here are your overdue cases.");

    // The stream endpoint was called exactly once with the transcript.
    const streamCall = fetchSpy.mock.calls.find(([url]: unknown[]) =>
      String(url).includes("/api/ai-agent/stream"),
    );
    expect(streamCall).toBeTruthy();
    const body = JSON.parse(String((streamCall![1] as RequestInit).body));
    const lastMsg = body.messages[body.messages.length - 1];
    expect(lastMsg).toMatchObject({ role: "user", content: "show me overdue cases" });
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
      expect(getByLabelText("Speak to Maynard")).toBeTruthy();
    });
    const streamCall = fetchSpy.mock.calls.find(([url]: unknown[]) =>
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
    await findByText("Could not transcribe audio. Please try again.");
    await waitFor(() => {
      expect(getByLabelText("Microphone error — tap to dismiss")).toBeTruthy();
    });

    // No stream request was dispatched.
    const streamCall = fetchSpy.mock.calls.find(([url]: unknown[]) =>
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

    await findByText("Could not transcribe audio. Please try again.");
    await waitFor(() => {
      expect(getByLabelText("Microphone error — tap to dismiss")).toBeTruthy();
    });
  });
});
