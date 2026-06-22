---
name: AI chat history persistence split
description: Why agentic AI endpoints silently failed cross-device chat sync, and the single-writer fix.
---

# AI chat history persistence

The `ai_chat_history` table is the cross-device store for Maynard's chat. Both
mobile (`ai-assistant.tsx`) and desktop (`AiChatPanel.tsx`) READ it via
`GET /api/ai-chat/history`, but they SEND messages via the agentic endpoints
(`POST /api/ai-agent` and `/ai-agent/stream`).

**The trap:** historically only the legacy `POST /api/ai-chat` endpoint wrote to
`ai_chat_history` (its private `persistExchange`). Neither client uses that
endpoint anymore, so nothing ever wrote rows → `/ai-chat/history` always
returned empty → cross-device sync looked "implemented" (read path existed) but
was silently dead.

**Fix / rule:** history writing lives in one shared lib
(`artifacts/api-server/src/lib/ai-chat-history.ts` → `persistAiChatExchange`,
`loadAiChatHistory`). Every endpoint that produces an assistant reply must call
it. In the agent endpoints it is fire-and-forget (`firePersist`), mirroring the
existing `fireLearn`, called ONLY at terminal TEXT replies — never on a
`proposed_action` (no assistant text yet).

**Why fire-and-forget is safe under fully-mocked `@workspace/db` tests:**
`persistAiChatExchange` is `async`, so a synchronous throw inside it (e.g. the
chain mock implements only `then`, so `.catch` is undefined) becomes a rejected
promise that `firePersist`'s `.catch` swallows — it never bubbles to a 500.
Calling a non-async helper synchronously here would have thrown into the route.

**How to apply:** if you add another AI reply surface, persist through the shared
lib at the terminal text point; don't re-implement a private writer, and don't
gate persistence on `labOrganizationId` (history is per-user, providers included)
— that gate belongs only to `fireLearn`.
