/**
 * @vitest-environment jsdom
 *
 * Regression guard: two core messenger reliability invariants.
 *
 * 1. Draft restoration on send failure — when the server rejects a message
 *    (network error, 500, etc.), the composer must restore the original text
 *    and file so the user doesn't lose their work silently.
 *
 * 2. Watermark deduplication — the mark-read endpoint must not be called on
 *    every unchanged poll cycle. It should fire only when the latest message
 *    ID changes (new message arrived or thread first opened).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React, { useRef, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@emoji-mart/react", () => ({
  default: () => null,
}));

vi.mock("@emoji-mart/data", () => ({ default: {} }));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrap(ui: React.ReactElement, qc = makeQC()) {
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// ── 1. MessengerComposer — draft restoration on send failure ──────────────────

describe("MessengerComposer — draft restoration on failure", () => {
  // Import the component lazily so mocks are in place first
  let MessengerComposer: typeof import("@/components/messenger/MessengerComposer").MessengerComposer;

  beforeEach(async () => {
    const mod = await import("@/components/messenger/MessengerComposer");
    MessengerComposer = mod.MessengerComposer;
  });

  it("restores the typed text when onSend throws", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("network error"));

    wrap(<MessengerComposer onSend={onSend} />);

    const textarea = screen.getByRole("textbox", { name: /message input/i });
    fireEvent.change(textarea, { target: { value: "Hello lab!" } });
    expect(textarea).toHaveValue("Hello lab!");

    // Press Enter to send
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // After the async failure, text should be restored
    await waitFor(() => {
      expect(textarea).toHaveValue("Hello lab!");
    });
  });

  it("surfaces an error banner when onSend throws", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("500"));

    wrap(<MessengerComposer onSend={onSend} />);

    const textarea = screen.getByRole("textbox", { name: /message input/i });
    fireEvent.change(textarea, { target: { value: "Test message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });

    expect(screen.getByRole("alert").textContent).toMatch(/failed to send/i);
  });

  it("clears the error banner when dismissed", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("err"));

    wrap(<MessengerComposer onSend={onSend} />);

    const textarea = screen.getByRole("textbox", { name: /message input/i });
    fireEvent.change(textarea, { target: { value: "msg" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("does NOT restore text when send succeeds", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);

    wrap(<MessengerComposer onSend={onSend} />);

    const textarea = screen.getByRole("textbox", { name: /message input/i });
    fireEvent.change(textarea, { target: { value: "Good message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledOnce();
    });

    // Text should be cleared on success
    expect(textarea).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ── 2. Watermark deduplication — hook-level logic ────────────────────────────

/**
 * Minimal component that replicates the mark-read effect logic from
 * ProviderMessengerChat and ConversationPanel.  We test the extracted logic
 * directly so we don't need to mock the full chat stack.
 */
function WatermarkHarness({
  messages,
  threadId,
  onMarkRead,
}: {
  messages: Array<{ id: string }>;
  threadId: string;
  onMarkRead: () => void;
}) {
  const lastMarkedMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    const latestMsg = messages[messages.length - 1];
    const latestId = latestMsg?.id ?? null;
    if (latestId === lastMarkedMessageIdRef.current) return;
    lastMarkedMessageIdRef.current = latestId;
    onMarkRead();
    // threadId intentionally listed as a dep so switching threads re-runs the effect.
  }, [threadId, messages, onMarkRead]);

  return <div data-testid="harness">{messages.length} msgs</div>;
}

describe("Mark-read watermark deduplication", () => {
  it("calls mark-read once when the same messages are fed multiple times (poll simulation)", () => {
    const onMarkRead = vi.fn();
    const msgs = [{ id: "msg-1" }, { id: "msg-2" }];

    const { rerender } = render(
      <WatermarkHarness messages={msgs} threadId="thread-a" onMarkRead={onMarkRead} />
    );

    // Simulate 3 more poll cycles with no new messages
    rerender(<WatermarkHarness messages={msgs} threadId="thread-a" onMarkRead={onMarkRead} />);
    rerender(<WatermarkHarness messages={msgs} threadId="thread-a" onMarkRead={onMarkRead} />);
    rerender(<WatermarkHarness messages={msgs} threadId="thread-a" onMarkRead={onMarkRead} />);

    // Should have only called mark-read once (initial render)
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it("calls mark-read again when a new message arrives", () => {
    const onMarkRead = vi.fn();
    const msgs = [{ id: "msg-1" }];

    const { rerender } = render(
      <WatermarkHarness messages={msgs} threadId="thread-a" onMarkRead={onMarkRead} />
    );

    expect(onMarkRead).toHaveBeenCalledTimes(1);

    // New message arrives
    const msgs2 = [{ id: "msg-1" }, { id: "msg-2" }];
    rerender(<WatermarkHarness messages={msgs2} threadId="thread-a" onMarkRead={onMarkRead} />);

    expect(onMarkRead).toHaveBeenCalledTimes(2);
  });

  it("calls mark-read on thread switch even when latest message ID is unchanged", () => {
    const onMarkRead = vi.fn();
    const msgs = [{ id: "msg-shared" }];

    // The real ConversationPanel uses key={thread.id} so each thread switch
    // fully remounts the component, resetting the lastMarkedMessageIdRef.
    // We replicate that here with React's key prop.
    const { rerender } = render(
      <WatermarkHarness key="thread-a" messages={msgs} threadId="thread-a" onMarkRead={onMarkRead} />
    );

    expect(onMarkRead).toHaveBeenCalledTimes(1);

    // Switch to a different thread (remount via key)
    rerender(
      <WatermarkHarness key="thread-b" messages={msgs} threadId="thread-b" onMarkRead={onMarkRead} />
    );

    // After remount the ref is fresh, so mark-read fires again even though the
    // latest message ID is the same shared one.
    expect(onMarkRead).toHaveBeenCalledTimes(2);
  });

  it("does NOT call mark-read when the thread has no messages yet", () => {
    const onMarkRead = vi.fn();

    const { rerender } = render(
      <WatermarkHarness messages={[]} threadId="thread-a" onMarkRead={onMarkRead} />
    );

    rerender(<WatermarkHarness messages={[]} threadId="thread-a" onMarkRead={onMarkRead} />);

    // latestId is null both times — should skip
    expect(onMarkRead).toHaveBeenCalledTimes(0);
  });
});
