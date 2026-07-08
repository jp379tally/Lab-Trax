/**
 * Pins the shared AI-stream error contract used by BOTH the mobile assistant
 * screen and the desktop AI chat panel. These strings are the cross-platform
 * behavior contract from the Maynard error-handling fix: each failure class
 * must be distinguishable in the UI. Keep permanently (regression policy).
 */
import { describe, it, expect } from "vitest";
import {
  AI_STREAM_NETWORK_ERROR_MESSAGE,
  AI_STREAM_INTERRUPTED_MESSAGE,
  AI_STREAM_SERVER_EVENT_FALLBACK_MESSAGE,
  aiStreamHttpErrorMessage,
  extractAiStreamHttpError,
} from "./ai-stream-errors";

describe("aiStreamHttpErrorMessage — status-to-message contract", () => {
  it("401 → session expired / sign in again", () => {
    expect(aiStreamHttpErrorMessage(401)).toBe(
      "Your session has expired. Please sign in again to keep using the AI assistant.",
    );
  });

  it("403 → not permitted", () => {
    expect(aiStreamHttpErrorMessage(403)).toBe(
      "You don't have permission to use the AI assistant on this account.",
    );
  });

  it("404 → server missing AI routes (outdated deployment)", () => {
    expect(aiStreamHttpErrorMessage(404)).toMatch(/outdated deployment/i);
  });

  it("429 → slow down", () => {
    expect(aiStreamHttpErrorMessage(429)).toBe(
      "Please slow down — try again in a moment.",
    );
  });

  it("500 surfaces the server error string when present", () => {
    expect(aiStreamHttpErrorMessage(500, "Failed to assemble context. Please try again.")).toBe(
      "AI error: Failed to assemble context. Please try again.",
    );
  });

  it("500 without a server string falls back to a generic server-error message", () => {
    expect(aiStreamHttpErrorMessage(500)).toMatch(/server hit an error/i);
  });

  it("503 uses the server-provided message when present", () => {
    const serverMsg =
      "AI assistant is not configured on this server. Please ask your administrator to set AI_INTEGRATIONS_OPENAI_API_KEY.";
    expect(aiStreamHttpErrorMessage(503, serverMsg)).toBe(serverMsg);
  });

  it("503 without a server string falls back to the not-configured message", () => {
    expect(aiStreamHttpErrorMessage(503)).toBe(
      "AI assistant is not configured on this server. Contact your administrator.",
    );
  });

  it("unknown statuses include the HTTP status for diagnosability", () => {
    expect(aiStreamHttpErrorMessage(418)).toBe(
      "Something went wrong (HTTP 418). Please try again.",
    );
    expect(aiStreamHttpErrorMessage(502)).toContain("HTTP 502");
  });

  it("every failure class produces a distinct message", () => {
    const messages = [401, 403, 404, 429, 500, 503].map((s) => aiStreamHttpErrorMessage(s));
    messages.push(AI_STREAM_NETWORK_ERROR_MESSAGE, AI_STREAM_INTERRUPTED_MESSAGE);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("network / interrupted-stream constants", () => {
  it("network failure message mentions connection trouble", () => {
    expect(AI_STREAM_NETWORK_ERROR_MESSAGE).toMatch(/connect/i);
  });

  it("interrupted-stream message mentions interruption", () => {
    expect(AI_STREAM_INTERRUPTED_MESSAGE).toMatch(/interrupted/i);
  });

  it("server-event fallback exists for non-string SSE error payloads", () => {
    expect(AI_STREAM_SERVER_EVENT_FALLBACK_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("extractAiStreamHttpError", () => {
  function fakeResp(status: number, body: string): { status: number; text: () => Promise<string> } {
    return { status, text: async () => body };
  }

  it("parses the JSON error field and maps it through the contract", async () => {
    const out = await extractAiStreamHttpError(
      fakeResp(503, JSON.stringify({ error: "AI assistant is not configured on this server. Please ask your administrator to set AI_INTEGRATIONS_OPENAI_API_KEY." })),
    );
    expect(out.status).toBe(503);
    expect(out.message).toContain("AI_INTEGRATIONS_OPENAI_API_KEY");
    expect(out.bodySnippet).toContain("not configured");
  });

  it("falls back to the message field when error is absent (auth middleware shape)", async () => {
    const out = await extractAiStreamHttpError(
      fakeResp(500, JSON.stringify({ ok: false, message: "boom" })),
    );
    expect(out.message).toBe("AI error: boom");
  });

  it("401 mapping does not leak the raw body into the message", async () => {
    const out = await extractAiStreamHttpError(
      fakeResp(401, JSON.stringify({ ok: false, message: "Authentication required." })),
    );
    expect(out.message).toBe(
      "Your session has expired. Please sign in again to keep using the AI assistant.",
    );
  });

  it("handles non-JSON bodies (proxy HTML error pages) without throwing", async () => {
    const out = await extractAiStreamHttpError(fakeResp(404, "<html>Not Found</html>"));
    expect(out.message).toMatch(/outdated deployment/i);
    expect(out.bodySnippet).toBe("<html>Not Found</html>");
  });

  it("handles an unreadable body without throwing", async () => {
    const out = await extractAiStreamHttpError({
      status: 429,
      text: async () => {
        throw new Error("stream already consumed");
      },
    });
    expect(out.message).toBe("Please slow down — try again in a moment.");
    expect(out.bodySnippet).toBe("");
  });

  it("truncates long bodies to a 300-char snippet for logging", async () => {
    const out = await extractAiStreamHttpError(fakeResp(500, "x".repeat(1000)));
    expect(out.bodySnippet.length).toBe(300);
  });
});
