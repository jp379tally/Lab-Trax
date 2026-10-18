// Real-time case-update channel for mobile (and any future client).
//
// Replaces having to rely solely on client-side polling for cross-device
// staleness: the mobile case detail screen opens a
// WebSocket scoped to the case it is viewing and gets pushed a lightweight
// "case-updated" event the moment a case-mutating route on the server
// finishes writing, instead of waiting for its next poll tick.
//
// Design notes:
// - One room per caseId. A client subscribes to a case by connecting with
//   `?ticket=<ticket>&caseId=<id>` in the query string (WebSocket has no
//   custom-header API on React Native's web/Expo-web target, so auth travels
//   in the URL). Rather than putting the long-lived bearer access token in
//   the URL (which risks exposure through proxy/access-log lines), the client
//   first calls the authenticated REST endpoint `POST
//   /cases/:caseId/ws-ticket` (see routes/cases.ts) to mint a single-use,
//   short-lived (WS_TICKET_TTL_MS) ticket scoped to exactly that user+case,
//   and only THAT opaque ticket appears in the WS URL. The server redeems the
//   ticket here (one-time use — deleted on lookup) before admitting the
//   connection to the room; an expired/reused/mismatched ticket gets a
//   policy-violation close, never silent room membership.
// - Broadcasting is fire-and-forget and MUST NOT throw back into the request
//   handler that triggered a case mutation: `broadcastCaseUpdated` swallows
//   all errors internally.
// - This is in-process pub/sub (a Map of caseId -> sockets). The server runs
//   as a single instance today (see rel-* workflows / no Redis pub/sub
//   elsewhere in this codebase), so this is sufficient; if the API server is
//   ever scaled horizontally, broadcasting would need to move to a shared bus
//   (e.g. Redis) so a mutation handled by instance A reaches a socket held by
//   instance B.
import type { Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { cases } from "@workspace/db";
import { requireMembership } from "./rbac";
import { notDeleted } from "./soft-delete";
import { logger } from "./logger";

// Must live under a path prefix the shared dev-preview proxy actually routes
// to this service (see artifacts/api-server/.replit-artifact/artifact.toml
// `paths`, currently ["/api", "/downloads", "/uploads", "/cases"]). A bare
// "/ws/cases" 502s in the Replit preview because the proxy never forwards it
// to this port at all.
const WS_PATH = "/api/ws/cases";
const HEARTBEAT_INTERVAL_MS = 30_000;

type CaseSocket = WebSocket & {
  userId?: string;
  caseId?: string;
  isAlive?: boolean;
};

// caseId -> sockets currently subscribed to updates for that case.
const caseRooms = new Map<string, Set<CaseSocket>>();

let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let ticketSweepTimer: ReturnType<typeof setInterval> | null = null;

// ── Single-use WS auth tickets ───────────────────────────────────────────
// A ticket is minted by the authenticated REST endpoint
// `POST /cases/:caseId/ws-ticket` (routes/cases.ts) — never by this module —
// and is redeemed exactly once here. It carries no information beyond an
// opaque random string, so a ticket leaking into a proxy/access-log line is
// far less damaging than a long-lived bearer token would be: it is scoped to
// one user + one case, expires in WS_TICKET_TTL_MS, and is deleted on first
// use (a replayed ticket is rejected).
const WS_TICKET_TTL_MS = 30_000;
const WS_TICKET_SWEEP_INTERVAL_MS = 60_000;

type WsTicket = { userId: string; caseId: string; expiresAt: number };
const wsTickets = new Map<string, WsTicket>();

/** Mints a single-use WS auth ticket scoped to one user + one case. */
export function issueCaseWsTicket(userId: string, caseId: string): string {
  const ticket = crypto.randomBytes(32).toString("base64url");
  wsTickets.set(ticket, { userId, caseId, expiresAt: Date.now() + WS_TICKET_TTL_MS });
  return ticket;
}

/**
 * Redeems (and deletes) a WS auth ticket. Returns the {userId, caseId} it was
 * minted for, or null if the ticket is missing, expired, or already used.
 */
function redeemCaseWsTicket(ticket: string): { userId: string; caseId: string } | null {
  const found = wsTickets.get(ticket);
  wsTickets.delete(ticket); // single-use regardless of outcome
  if (!found) return null;
  if (found.expiresAt < Date.now()) return null;
  return { userId: found.userId, caseId: found.caseId };
}

/**
 * Same tenant rule as the REST case routes' `assertCaseAccessWithMemberships`
 * (lab OR provider org membership), reimplemented here rather than imported
 * to avoid a circular import between this module and `routes/cases.ts`
 * (which imports `broadcastCaseUpdated` from here).
 */
async function userCanAccessCase(userId: string, caseId: string): Promise<boolean> {
  const found = await db.query.cases.findFirst({
    where: and(eq(cases.id, caseId), notDeleted(cases)),
  });
  if (!found) return false;
  const [labMembership, providerMembership] = await Promise.all([
    requireMembership(userId, found.labOrganizationId).catch(() => null),
    found.providerOrganizationId
      ? requireMembership(userId, found.providerOrganizationId).catch(() => null)
      : Promise.resolve(null),
  ]);
  return Boolean(labMembership || providerMembership);
}

function addToRoom(caseId: string, ws: CaseSocket): void {
  let room = caseRooms.get(caseId);
  if (!room) {
    room = new Set();
    caseRooms.set(caseId, room);
  }
  room.add(ws);
}

function removeFromRoom(caseId: string, ws: CaseSocket): void {
  const room = caseRooms.get(caseId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) caseRooms.delete(caseId);
}

export function attachCaseEventsWebSocketServer(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on("connection", (rawSocket, req) => {
    const ws = rawSocket as CaseSocket;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    void (async () => {
      try {
        const url = new URL(req.url ?? "", "http://internal");
        const ticket = url.searchParams.get("ticket");
        const caseId = url.searchParams.get("caseId");
        if (!ticket || !caseId) {
          ws.close(4000, "ticket and caseId query params are required");
          return;
        }

        const redeemed = redeemCaseWsTicket(ticket);
        if (!redeemed) {
          ws.close(4001, "Invalid, expired, or already-used ticket");
          return;
        }
        // Defense in depth: the ticket is minted for a specific case, so a
        // mismatched caseId query param (stale tab, copy-paste, tampering)
        // is rejected even though the ticket itself redeemed successfully.
        if (redeemed.caseId !== caseId) {
          ws.close(4003, "Ticket does not match the requested case");
          return;
        }
        const userId = redeemed.userId;

        const allowed = await userCanAccessCase(userId, caseId);
        if (!allowed) {
          ws.close(4003, "Not authorized for this case");
          return;
        }

        ws.userId = userId;
        ws.caseId = caseId;
        addToRoom(caseId, ws);

        ws.on("close", () => {
          if (ws.caseId) removeFromRoom(ws.caseId, ws);
        });
      } catch (err) {
        logger.error({ err }, "case-events-ws: connection setup failed");
        try {
          ws.close(1011, "Internal error");
        } catch {
          /* ignore */
        }
      }
    })();
  });

  // Dead-connection sweep: a client that lost network without a clean close
  // (phone locked, app backgrounded, wifi drop) never fires a "close" event on
  // the server, so its room membership would otherwise leak forever.
  heartbeatTimer = setInterval(() => {
    wss?.clients.forEach((rawSocket) => {
      const ws = rawSocket as CaseSocket;
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  // Sweep tickets that were minted but never redeemed (client crashed before
  // connecting, network drop, etc.) so the map does not grow unbounded.
  ticketSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [ticket, entry] of wsTickets) {
      if (entry.expiresAt < now) wsTickets.delete(ticket);
    }
  }, WS_TICKET_SWEEP_INTERVAL_MS);
  ticketSweepTimer.unref();

  logger.info({ path: WS_PATH }, "case-events-ws: attached");
}

/**
 * Notify every client currently viewing `caseId` that it changed on the
 * server, so it can refetch immediately instead of waiting for its next poll.
 * Fire-and-forget: never throws, safe to call without awaiting from any
 * case-mutating route.
 */
export function broadcastCaseUpdated(caseId: string | null | undefined, eventType?: string): void {
  try {
    if (!caseId) return;
    const room = caseRooms.get(caseId);
    if (!room || room.size === 0) return;
    const payload = JSON.stringify({
      type: "case-updated",
      caseId,
      eventType: eventType ?? null,
      at: new Date().toISOString(),
    });
    for (const ws of room) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  } catch (err) {
    logger.error({ err, caseId }, "case-events-ws: broadcast failed");
  }
}
