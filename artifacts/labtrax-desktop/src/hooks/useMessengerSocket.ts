import { useEffect, useRef, useCallback } from "react";
import { getAccessToken, getApiOrigin } from "@/lib/api";

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

    ws.onopen = () => {
      reconnectDelayRef.current = INITIAL_RECONNECT_MS;
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
      reconnectTimerRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(
          reconnectDelayRef.current * 2,
          MAX_RECONNECT_MS
        );
        connect();
      }, reconnectDelayRef.current);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    destroyedRef.current = false;
    connect();
    return () => {
      destroyedRef.current = true;
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
