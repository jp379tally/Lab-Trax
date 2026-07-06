---
name: Messenger read watermark dual paths
description: The two messenger read paths (REST + WebSocket) that both move last_read_at, and the semantics they must share.
---

# Messenger read watermark has TWO independent paths

`conversation_participants.last_read_at` is advanced by two separate handlers
that must stay in lockstep, or the unread badge and the sender's "Seen"
indicator disagree:

- REST durable path — `POST /messenger/conversations/:id/read`
  (`artifacts/api-server/src/routes/messenger.ts`), called by the desktop
  client's `persistRead` (`MessengerContext.tsx`). This is the durable source
  of truth for the unread badge.
- WebSocket path — `mark_read` handler
  (`artifacts/api-server/src/lib/messenger-ws.ts`), which also drives the other
  user's real-time "Seen" indicator.

**Rule:** both must bound the watermark to the message the caller actually saw
(`lastMessageId`), validating it belongs to the conversation and is not deleted,
and set `last_read_at` to that message's `created_at` — never to the latest
message in the conversation. The REST path historically ignored the body and
always jumped to the latest message, which silently marked a message that
arrived after the user's last view as read (badge never appeared). The client
sends the viewed id in the read body; the server falls back to latest only when
no id is supplied (backward compat).

**Why:** if one path bounds and the other jumps to latest, a genuinely-new
message shows as read on one surface and unread on the other.

**Known remaining gap:** neither path guards against the watermark moving
*backward*. A delayed/duplicate read for an older message (second device, stale
reconcile, out-of-order WS/REST) can regress `last_read_at` and resurrect newer
messages as unread. Fix = advance-only (max of current vs target created_at).

**How to apply:** any change to either read handler must be mirrored in the
other; `artifacts/api-server/src/routes/messenger-read.test.ts` pins the REST
server-side contract.
