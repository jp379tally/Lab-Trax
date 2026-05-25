import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { db } from "@workspace/db";
import {
  conversations,
  conversationParticipants,
  messages,
  users,
  userSessions,
} from "@workspace/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { verifyAccessToken } from "./auth";
import { logger } from "./logger";

export type WsEnvelope =
  | { type: "chat_message"; payload: ChatMessagePayload }
  | { type: "typing_start"; payload: TypingPayload }
  | { type: "typing_stop"; payload: TypingPayload }
  | { type: "presence_ping"; payload: Record<string, never> }
  | { type: "presence_pong"; payload: { onlineUserIds: string[] } }
  | { type: "mark_read"; payload: MarkReadPayload }
  | { type: "message_seen"; payload: MessageSeenPayload }
  | { type: "error"; payload: { message: string } };

export interface ChatMessagePayload {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
}

export interface TypingPayload {
  conversationId: string;
  userId: string;
}

export interface MarkReadPayload {
  conversationId: string;
  lastMessageId: string;
}

export interface MessageSeenPayload {
  conversationId: string;
  seenByUserId: string;
  lastMessageId: string;
}

const connectedSockets = new Map<string, Set<WebSocket>>();

export function getOnlineUserIds(): string[] {
  return Array.from(connectedSockets.keys());
}

function addSocket(userId: string, ws: WebSocket) {
  if (!connectedSockets.has(userId)) {
    connectedSockets.set(userId, new Set());
  }
  connectedSockets.get(userId)!.add(ws);
}

function removeSocket(userId: string, ws: WebSocket) {
  const set = connectedSockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    connectedSockets.delete(userId);
  }
}

function sendToUser(userId: string, envelope: WsEnvelope) {
  const sockets = connectedSockets.get(userId);
  if (!sockets) return;
  const payload = JSON.stringify(envelope);
  for (const ws of sockets) {
    try {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    } catch {
      // ignore dead socket
    }
  }
}

async function getConversationParticipantIds(
  conversationId: string
): Promise<string[]> {
  const rows = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId));
  return rows.map((r) => r.userId);
}

async function isParticipant(
  userId: string,
  conversationId: string
): Promise<boolean> {
  const row = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId)
      )
    )
    .limit(1);
  return row.length > 0;
}

async function handleMessage(
  userId: string,
  raw: string
): Promise<void> {
  let envelope: { type: string; payload: unknown };
  try {
    envelope = JSON.parse(raw) as { type: string; payload: unknown };
  } catch {
    return;
  }

  const { type, payload } = envelope;

  if (type === "presence_ping") {
    sendToUser(userId, {
      type: "presence_pong",
      payload: { onlineUserIds: getOnlineUserIds() },
    });
    return;
  }

  if (type === "typing_start" || type === "typing_stop") {
    const p = payload as { conversationId?: string };
    if (!p.conversationId) return;
    if (!(await isParticipant(userId, p.conversationId))) return;
    const participantIds = await getConversationParticipantIds(p.conversationId);
    for (const pid of participantIds) {
      if (pid === userId) continue;
      sendToUser(pid, {
        type: type as "typing_start" | "typing_stop",
        payload: { conversationId: p.conversationId, userId },
      });
    }
    return;
  }

  if (type === "mark_read") {
    const p = payload as { conversationId?: string; lastMessageId?: string };
    if (!p.conversationId || !p.lastMessageId) return;
    if (!(await isParticipant(userId, p.conversationId))) return;

    const msgRow = await db
      .select({ createdAt: messages.createdAt, senderId: messages.senderId })
      .from(messages)
      .where(
        and(
          eq(messages.id, p.lastMessageId),
          eq(messages.conversationId, p.conversationId),
          isNull(messages.deletedAt)
        )
      )
      .limit(1);
    if (!msgRow[0]) return;

    await db
      .update(conversationParticipants)
      .set({ lastReadAt: msgRow[0].createdAt })
      .where(
        and(
          eq(conversationParticipants.conversationId, p.conversationId),
          eq(conversationParticipants.userId, userId)
        )
      );

    const senderId = msgRow[0].senderId;
    if (senderId !== userId) {
      sendToUser(senderId, {
        type: "message_seen",
        payload: {
          conversationId: p.conversationId,
          seenByUserId: userId,
          lastMessageId: p.lastMessageId,
        },
      });
    }
    return;
  }
}

export function fanOutMessage(
  participantIds: string[],
  messagePayload: ChatMessagePayload
) {
  for (const pid of participantIds) {
    sendToUser(pid, { type: "chat_message", payload: messagePayload });
  }
}

async function authenticateWsRequest(
  token: string
): Promise<string | null> {
  let payload: { sub: string; sid: string };
  try {
    payload = verifyAccessToken(token) as { sub: string; sid: string };
  } catch {
    return null;
  }

  const session = await db.query.userSessions.findFirst({
    where: and(
      eq(userSessions.id, payload.sid),
      eq(userSessions.userId, payload.sub),
      isNull(userSessions.revokedAt),
      gt(userSessions.expiresAt, new Date())
    ),
  });
  if (!session) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.id, payload.sub),
  });
  if (!user || !user.isActive) return null;

  return payload.sub;
}

export function setupMessengerWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/ws/messenger")) {
      socket.destroy();
      return;
    }

    const parsed = new URL(url, "http://localhost");
    const tokenFromQuery = parsed.searchParams.get("token");
    const protocolHeader = req.headers["sec-websocket-protocol"];
    const tokenFromProtocol =
      typeof protocolHeader === "string"
        ? protocolHeader.replace(/^bearer\s+/i, "").trim()
        : undefined;
    const token = tokenFromQuery ?? tokenFromProtocol ?? "";

    authenticateWsRequest(token)
      .then((userId) => {
        if (!userId) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          addSocket(userId, ws);
          logger.info({ userId }, "[messenger-ws] Client connected");

          sendToUser(userId, {
            type: "presence_pong",
            payload: { onlineUserIds: getOnlineUserIds() },
          });

          ws.on("message", (data) => {
            handleMessage(userId, data.toString()).catch((err) => {
              logger.warn({ err, userId }, "[messenger-ws] Error handling message");
            });
          });

          ws.on("close", () => {
            removeSocket(userId, ws);
            logger.info({ userId }, "[messenger-ws] Client disconnected");
          });

          ws.on("error", (err) => {
            logger.warn({ err, userId }, "[messenger-ws] Socket error");
            removeSocket(userId, ws);
          });
        });
      })
      .catch((err) => {
        logger.warn({ err }, "[messenger-ws] Auth error during upgrade");
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      });
  });

  return wss;
}
