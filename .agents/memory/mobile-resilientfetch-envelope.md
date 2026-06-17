---
name: Mobile resilientFetch returns the raw envelope
description: Why raw resilientFetch callers must read body.data.X, not body.X, on the labtrax mobile client
---

The api-server `ok()` helper wraps every success response as `{ ok: true, data: <payload> }`.
On the labtrax mobile client, `resilientFetch` (lib/query-client.ts) is a **pass-through**:
it returns the raw `Response`, so `await res.json()` gives the wrapped body. It does NOT
unwrap the envelope (unlike the orval-generated hooks / `apiRequest` paths).

**The trap:** a raw `resilientFetch` caller that reads `body.case` (or any `body.<field>`)
gets `undefined`, because the payload lives at `body.data.case`. Undefined reads fail
*silently* — the screen shows a "not found" style message even though the server returned
200 with the data. This is what made barcode lookup ("No case found for that pan") look
like a backend miss when the backend was fine.

**How to apply:** any handler that calls `resilientFetch` directly and parses JSON must
read `body.data.<field>` (prefer `body.data?.x ?? body.x` for resilience). Prefer a small
pure extractor helper so it is unit-testable (see `lib/barcode-lookup.ts`).

**Why:** desktop has the mirror-image fact recorded in `desktop-apifetch-unwrap.md`
(desktop `apiFetch` *does* unwrap). The two clients differ, so the same response shape is
read differently depending on which transport wrapper the caller used.
