import { useEffect, useRef, useCallback } from "react";
import { getAccessToken, getApiOrigin, refreshAccessTokenNow } from "@/lib/api";

export type WsMessageType =
  | "chat_message"
  | "typing_start"
  | "typing_stop"
  | "presence_ping"
  | "presence_pong"
  | "mark_read"
  | "message_seen"
  | "error";

export interface WsEnvelope {
  type: WsMessageType;
  payload: unknown;
}

export type WsHandler = (envelope: WsEnvelope) => void;

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
// Short delay before reconnecting immediately after a proactive token refresh —
// long enough to let the refreshed token settle, short enough to feel instant.
const POST_REFRESH_RECONNECT_MS = 300;
// After this many consecutive handshakes that close *without ever opening*
// (i.e. the server keeps rejecting us — a permanent auth failure such as an
// expired session we couldn't refresh, or a disabled account), stop retrying
// instead of spamming reconnects forever. Resets to 0 on any successful open,
// so a later re-authentication or transient recovery resumes normally.
const MAX_AUTH_FAILURES = 6;

function buildWsUrl(): string {
  const origin = getApiOrigin();
  const token = getAccessToken() ?? "";
  let wsBase: string;
  if (origin.startsWith("https://")) {
    wsBase = "wss://" + origin.slice(8);
  } else if (origin.startsWith("http://")) {
    wsBase = "ws://" + origin.slice(7);
  } else {
    const loc = window.location;
    wsBase = (loc.protocol === "https:" ? "wss://" : "ws://") + loc.host;
  }
  return `${wsBase}/ws/messenger?token=${encodeURIComponent(token)}`;
}

export interface MessengerSocketHandle {
  send: (envelope: WsEnvelope) => void;
}

export function useMessengerSocket(
  onMessage: WsHandler,
  enabled = true
): MessengerSocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_MS);
  const destroyedRef = useRef(false);
  // Tracks whether the *current* socket ever reached the OPEN state. A close
  // without an open is treated as an auth-suspect handshake failure (the WS
  // handshake surfaces a 401 as a plain abnormal close, so we can't read the
  // status directly).
  const openedRef = useRef(false);
  // Consecutive close-without-open count; drives the give-up cap.
  const authFailuresRef = useRef(0);
  // Whether we've already spent our single token refresh for the current
  // failure streak. Reset after a successful open so a later token expiry gets
  // a fresh refresh.
  const refreshedThisStreakRef = useRef(false);
  const onMessageRef = useRef<WsHandler>(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (destroyedRef.current || !enabled) return;
    if (!getAccessToken()) return;

    const url = buildWsUrl();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    wsRef.current = ws;
    openedRef.current = false;

    const scheduleReconnect = (delayMs: number) => {
      if (destroyedRef.current) return;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, delayMs);
    };

    ws.onopen = () => {
      openedRef.current = true;
      reconnectDelayRef.current = INITIAL_RECONNECT_MS;
      authFailuresRef.current = 0;
      refreshedThisStreakRef.current = false;
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "presence_ping", payload: {} }));
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data as string) as WsEnvelope;
        onMessageRef.current(envelope);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (destroyedRef.current) return;

      if (openedRef.current) {
        // Normal drop after a healthy connection — treat as a transient network
        // blip and reconnect with exponential backoff, indefinitely.
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_MS);
        scheduleReconnect(delay);
        return;
      }

      // Never opened → auth-suspect handshake failure.
      authFailuresRef.current += 1;
      if (authFailuresRef.current > MAX_AUTH_FAILURES) {
        // Permanent auth failure — stop reconnecting instead of looping forever.
        // A future re-auth (which remounts/re-enables this hook) resumes.
        return;
      }

      if (!refreshedThisStreakRef.current) {
        // First failure of this streak: the token may simply be expired while
        // the REST layer refreshes it elsewhere. Refresh once, then reconnect
        // with the fresh token baked into the URL.
        refreshedThisStreakRef.current = true;
        void refreshAccessTokenNow().finally(() => {
          scheduleReconnect(POST_REFRESH_RECONNECT_MS);
        });
        return;
      }

      // Already refreshed and still failing — back off exponentially up to the
      // give-up cap.
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_MS);
      scheduleReconnect(delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    destroyedRef.current = false;
    authFailuresRef.current = 0;
    refreshedThisStreakRef.current = false;
    reconnectDelayRef.current = INITIAL_RECONNECT_MS;
    connect();

    // The give-up cap (MAX_AUTH_FAILURES) also trips on a run of never-opened
    // handshakes caused by a transient network/server outage — not just a
    // permanent auth failure, which we can't distinguish at the WS layer. When
    // the browser reports the network is back, clear the failure streak and
    // reconnect so messenger recovers instead of staying dead until remount.
    const onOnline = () => {
      if (destroyedRef.current) return;
      authFailuresRef.current = 0;
      refreshedThisStreakRef.current = false;
      reconnectDelayRef.current = INITIAL_RECONNECT_MS;
      const ws = wsRef.current;
      if (
        !ws ||
        ws.readyState === WebSocket.CLOSED ||
        ws.readyState === WebSocket.CLOSING
      ) {
        connect();
      }
    };
    window.addEventListener("online", onOnline);

    return () => {
      destroyedRef.current = true;
      window.removeEventListener("online", onOnline);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect, enabled]);

  const send = useCallback((envelope: WsEnvelope) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(envelope));
    }
  }, []);

  return { send };
}
