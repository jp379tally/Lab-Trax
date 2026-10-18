// Real-time case-update channel for the mobile case detail screen.
//
// Server side: artifacts/api-server/src/lib/case-events-ws.ts runs a
// WebSocket server at `/api/ws/cases` on the same HTTP server/port as the
// REST API. A client connects with `?ticket=<ticket>&caseId=<id>` in the URL
// (React Native's WebSocket has no custom-header API on the web/Expo-web
// target, so auth travels in the query string). Rather than putting the
// long-lived bearer access token there, the client first calls the
// authenticated REST endpoint `POST /api/cases/:caseId/ws-ticket` (normal
// Authorization header, no query-string secrets) to mint a single-use,
// short-lived ticket scoped to exactly this user+case, and only that opaque
// ticket goes into the WS URL. The server redeems the ticket, re-checks
// lab/provider access to the case, then pushes a `{"type":"case-updated"}`
// message any time that case is mutated server-side (see
// broadcastCaseUpdated call sites across the api-server routes).
//
// This is a supplementary push channel, not a replacement for polling: the
// socket can silently drop (backgrounded app, network handoff, server
// restart) with no delivery guarantee, so callers should keep a much longer
// safety-net `refetchInterval` alongside this hook rather than removing
// polling entirely.
import { useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { getApiUrl, waitForHydration, refreshAndGetAccessToken, apiRequest } from "./query-client";

/**
 * Refresh every independent server-state query rendered by the case detail
 * screen. Attachments and invoices do not live inside the useCase response,
 * so refreshing only ["cases", caseId] leaves visible sections stale.
 */
export async function refreshCaseDetailQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  caseId: string,
): Promise<void> {
  await Promise.all([
    // Prefix invalidation refreshes both the case and its attachments query.
    queryClient.invalidateQueries({ queryKey: ["cases", caseId] }),
    // Refresh the case-filtered invoice list and any active invoice detail.
    queryClient.invalidateQueries({ queryKey: ["invoices"] }),
  ]);
}

/** Calls the REST ticket-mint endpoint. Returns null on any failure. */
async function fetchWsTicket(caseId: string): Promise<string | null> {
  try {
    const res = await apiRequest("POST", `api/cases/${encodeURIComponent(caseId)}/ws-ticket`);
    const body = await res.json();
    const ticket: unknown = body?.data?.ticket ?? body?.ticket;
    return typeof ticket === "string" && ticket ? ticket : null;
  } catch {
    return null;
  }
}

function buildCaseWsUrl(caseId: string, ticket: string): string {
  // getApiUrl() returns an http(s) URL with a trailing slash, e.g.
  // "https://my-app.example.dev/". Swap the scheme for ws/wss and resolve
  // the WS path against it. The path must live under "/api" — that's the
  // only prefix the shared dev-preview proxy forwards to the api-server
  // service (see case-events-ws.ts's WS_PATH comment for why).
  const httpBase = getApiUrl();
  const wsBase = httpBase.replace(/^http/i, (m) => (m.toLowerCase() === "https" ? "wss" : "ws"));
  const url = new URL("api/ws/cases", wsBase);
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("caseId", caseId);
  return url.toString();
}

const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
// A close-without-ever-opening is auth-suspect (see
// desktop-platform-admin-403-and-ws-auth-loop lesson): after a couple of
// those in a row, try one token refresh before continuing to back off,
// rather than retrying the same stale token forever.
const NEVER_OPENED_STREAK_BEFORE_REFRESH = 2;
const MAX_RETRIES = 8;

/**
 * Subscribes to real-time update events for a single case over WebSocket.
 * Calls `onUpdate` (via a ref, so callers can pass an inline closure without
 * causing reconnects) whenever the server reports the case changed.
 *
 * A no-op while `caseId` is falsy. Reconnects automatically with backoff on
 * unexpected close; gives up after a bounded number of retries (the
 * safety-net poll interval on the caller's query takes over from there).
 */
export function useCaseRealtimeUpdates(
  caseId: string | undefined | null,
  onUpdate: () => void,
): void {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!caseId) return;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let neverOpenedStreak = 0;
    let hasEverOpened = false;

    function clearTimer() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function scheduleReconnect() {
      if (cancelled) return;
      if (retryCount >= MAX_RETRIES) return;
      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * 2 ** retryCount,
        MAX_RECONNECT_DELAY_MS,
      );
      retryCount += 1;
      clearTimer();
      reconnectTimer = setTimeout(() => {
        void connect();
      }, delay);
    }

    async function connect() {
      if (cancelled) return;
      await waitForHydration();
      if (cancelled) return;

      // A run of closes before the socket ever finished opening looks like a
      // rejected/expired token rather than a transient network blip — force
      // a refresh before minting the next ticket (the ticket-mint request
      // below will pick up the refreshed bearer token automatically).
      if (neverOpenedStreak >= NEVER_OPENED_STREAK_BEFORE_REFRESH) {
        await refreshAndGetAccessToken();
        neverOpenedStreak = 0;
      }
      if (cancelled || !caseId) return;

      const ticket = await fetchWsTicket(caseId);
      if (!ticket || cancelled || !caseId) {
        // A missing ticket can mean "not authenticated" (no point retrying
        // until the caller re-mounts with a fresh session) or a transient
        // network failure while fetching it — treat both the same way the
        // socket layer treats a failed open, so a real network blip still
        // gets the same bounded backoff/retry as before.
        scheduleReconnect();
        return;
      }

      hasEverOpened = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(buildCaseWsUrl(caseId, ticket));
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;

      ws.onopen = () => {
        hasEverOpened = true;
        retryCount = 0;
        neverOpenedStreak = 0;
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data));
          if (payload?.type === "case-updated" && payload?.caseId === caseId) {
            onUpdateRef.current();
          }
        } catch {
          // Ignore malformed frames.
        }
      };

      ws.onerror = () => {
        // The close handler (always fired after error on RN's WebSocket)
        // drives reconnection; nothing to do here beyond suppressing the
        // default unhandled-event noise.
      };

      ws.onclose = () => {
        if (socket === ws) socket = null;
        if (!hasEverOpened) neverOpenedStreak += 1;
        if (!cancelled) scheduleReconnect();
      };
    }

    void connect();

    return () => {
      cancelled = true;
      clearTimer();
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
        socket = null;
      }
    };
  }, [caseId]);
}
