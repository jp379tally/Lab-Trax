---
name: AI chat history pagination cursor
description: Why the "load earlier" cursor must be a real server id, not a client-local message id, in both LabTrax AI chat clients.
---

# AI chat history "load earlier" cursor

`GET /api/ai-chat/history` pages backwards with a `before` cursor that is a
server message id (resolved against `(createdAt, id)` scoped to the user).

**Rule:** the `before` cursor passed from a client MUST be a real server-row id.

**Why:** server history rows carry server-generated hex ids; the desktop and
mobile local-cache messages use locally generated ids (`generateId()` /
`genId()`) that never match server ids. If you pass a local id as `before`, the
server cursor lookup resolves to null and silently returns the **latest** page
again — producing duplicates / an infinite "load earlier" that never advances.

**How to apply:**
- Track an `historyCursorRef` holding the oldest *server* id currently shown.
  Seed it only from a server fetch (`loadServerHistory` / the `/ai-chat/history`
  reconcile), never from local-cache messages.
- Both clients reconcile on mount: show local instantly, then fetch the server
  page; adopt server messages (real ids) when the server holds >= local count,
  and record `hasMore` + the oldest server id as the cursor.
- On "load earlier", fetch `?before=<cursor>&limit=50`, dedup by id when
  prepending, keep the welcome message pinned at index 0, and update the cursor
  to the new oldest id.
- Retention: `MAX_HISTORY_ROWS` raised 100 -> 1000; per-page cap
  `HISTORY_PAGE_MAX = 100`.
