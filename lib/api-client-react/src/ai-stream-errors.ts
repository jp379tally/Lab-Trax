/**
 * Shared error contract for the AI assistant stream (`POST /ai-agent/stream`).
 *
 * Both the mobile assistant screen (labtrax) and the desktop AI chat panel
 * (labtrax-desktop) map stream failures to user-facing messages through this
 * single helper so the two platforms always behave identically. Do NOT
 * duplicate these strings in client code — import them from here.
 *
 * Failure classes covered:
 *  - HTTP 401  → session expired / sign in again
 *  - HTTP 403  → not permitted
 *  - HTTP 404  → server missing the AI routes (likely outdated deployment)
 *  - HTTP 429  → rate limited
 *  - HTTP 500  → server error (surfaces the server's error string when present)
 *  - HTTP 503  → AI not configured on this server
 *  - network   → request never reached the server
 *  - interrupted → SSE stream aborted / malformed before a terminal event
 */

/** Shown when the fetch itself rejects (no HTTP response at all). */
export const AI_STREAM_NETWORK_ERROR_MESSAGE =
  "Sorry, I'm having trouble connecting right now. Please check your connection and try again.";

/** Shown when the SSE stream ends or breaks before a terminal event arrives. */
export const AI_STREAM_INTERRUPTED_MESSAGE =
  "The AI response was interrupted before it finished. Please try again.";

/** Fallback shown when a server `error` SSE event carries no usable string. */
export const AI_STREAM_SERVER_EVENT_FALLBACK_MESSAGE =
  "Something went wrong. Please try again.";

/**
 * Map a non-2xx HTTP status from the AI stream endpoint to a user-facing
 * message. `serverError` is the `error` string from the JSON response body
 * when one could be parsed; it takes precedence for 500/503 where the server
 * provides actionable detail.
 */
export function aiStreamHttpErrorMessage(
  status: number,
  serverError?: string | null,
): string {
  switch (status) {
    case 401:
      return "Your session has expired. Please sign in again to keep using the AI assistant.";
    case 403:
      return "You don't have permission to use the AI assistant on this account.";
    case 404:
      return "This server doesn't have the AI assistant available — it may be running an outdated deployment. Please contact your administrator.";
    case 429:
      return "Please slow down — try again in a moment.";
    case 500:
      return serverError
        ? `AI error: ${serverError}`
        : "The server hit an error while processing your request. Please try again.";
    case 503:
      return (
        serverError ||
        "AI assistant is not configured on this server. Contact your administrator."
      );
    default:
      return `Something went wrong (HTTP ${status}). Please try again.`;
  }
}

/**
 * Read a failed stream `Response` and produce the mapped user message plus a
 * short body snippet for diagnostic logging. Never throws.
 *
 * Accepts a minimal structural response type so both the DOM `Response`
 * (desktop/web) and React Native's fetch response (mobile) satisfy it.
 */
export async function extractAiStreamHttpError(resp: {
  status: number;
  text: () => Promise<string>;
}): Promise<{ message: string; status: number; bodySnippet: string }> {
  let bodyText = "";
  try {
    bodyText = await resp.text();
  } catch {
    // Body unreadable — fall through with an empty snippet.
  }
  let serverError: string | null = null;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string" && parsed.error) serverError = parsed.error;
      else if (typeof parsed.message === "string" && parsed.message) serverError = parsed.message;
    } catch {
      // Non-JSON body (HTML error page etc.) — ignore, use status mapping only.
    }
  }
  return {
    message: aiStreamHttpErrorMessage(resp.status, serverError),
    status: resp.status,
    bodySnippet: bodyText.slice(0, 300),
  };
}
