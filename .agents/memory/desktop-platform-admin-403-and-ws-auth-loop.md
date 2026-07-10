---
name: Desktop platform-admin 403 polling & messenger WS auth loop
description: Frontend patterns that stop console-flooding from forbidden maintenance endpoints and from a WebSocket that reconnects forever with a stale token.
---

# Two independent console-flooding causes in labtrax-desktop (lab-scoped admin)

## Platform-admin queries must stop on 403
React Query hooks that hit **platform-admin-only** maintenance endpoints
(backup schedule, orphaned-media cleanup runs/status, cleanup schedule) will
keep retrying and polling on their `refetchInterval` after a legitimate 403,
spamming the endpoint and console. A lab-scoped admin without platform-admin
credentials *correctly* gets 403 — do NOT loosen the backend.

**Fix:** `lib/platform-admin-query.ts` exposes `retryUnlessForbidden` (never
retry a 403, else mirror the app default `retry:1`) and
`haltPollingIfForbidden(base)` (wraps `refetchInterval`, returns `false` once
`query.state.error` is a 403). Apply BOTH to every platform-admin query.
Callers already invalidate these queries on unlock, so success resumes polling.

**How to apply:** any new query against `/admin/...` platform-admin routes in
the desktop renderer must add `retry: retryUnlessForbidden` and, if it polls,
wrap the interval in `haltPollingIfForbidden(...)`.

## Messenger WebSocket: refresh-once-then-cap, don't loop forever
`useMessengerSocket` reconnected forever with an expired token because the WS
handshake surfaces a 401 as a plain abnormal close — the browser cannot read
the HTTP status. Meanwhile the REST layer silently refreshes tokens elsewhere,
so the WS URL keeps carrying a dead token.

**Fix / rule:** treat a **close without a prior open** as auth-suspect. On the
first such close of a streak, refresh the token once (`refreshAccessTokenNow`
newly exported from `api.ts`; `refreshAccessToken` itself stays private) and
reconnect with the fresh token baked into the URL. Then exponential backoff, and
**give up after N consecutive never-opened closes** instead of looping. A
successful open resets the counter, so healthy open→drop cycles reconnect
indefinitely (transient-network resilience is preserved).

**Why:** you can't distinguish auth-reject from network-down at the WS layer, so
the discriminator is "did it ever open?" + a single proactive refresh + a cap.
