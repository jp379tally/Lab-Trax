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

afterEach(() => {
  cleanup();
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
