---
name: Mobile cookie-jar CSRF trap
description: Why native (Expo) state-changing requests intermittently 403 with "lab rejected this change" and how the bearer-only invariant prevents it.
---

# Mobile cookie-jar CSRF trap

Symptom: mobile case status/photo/note syncs silently fail; web/desktop never
see the change. Server logs show `POST /api/legacy/cases` (and other writes)
returning **403 in ~1ms** while GETs succeed. The offline queue then shows a red
**"The lab rejected this change"** banner (it categorizes any non-400/422 4xx as
"rejected").

**Root cause:** React Native's `fetch` has an automatic cookie jar. If the server
ever sends `Set-Cookie` to the mobile client, those auth cookies get attached to
later POSTs. The native client only adds `Authorization: Bearer` when the
in-memory access token is populated. When it is momentarily null (offline-queue
drain firing at launch before token hydration, or after a transient clear), the
POST goes out **cookie-only, no bearer, no csrf header** → the CSRF middleware
(`requireCsrf`, guards only state-changing methods, hence GET works) returns 403.
A clean 401 would have triggered refresh+retry; the CSRF 403 short-circuits that
and wedges the queue.

**Invariant to keep:** mobile AND desktop are **cookie-less bearer clients**. The
server must only call `setAuthCookies` for `clientType === "web"` (register/login)
and only when the refresh token came from a cookie (`!fromBody`) on `/refresh`.
Never issue `Set-Cookie` to bearer clients — otherwise the RN cookie jar recreates
this trap.

**Why both a server and client fix:** the server gate stops *new* logins from
getting cookies; the client fix (hydrate `loadTokens()` + `refreshAccessToken()`
before any native request when `_accessToken` is null) guarantees a bearer is
attached and rescues *existing* installs whose RN jar already holds cookies —
without forcing a re-login.

**How to apply:** any time you touch auth cookie issuance or the native fetch
wrapper, preserve "bearer clients never receive cookies" and "never send a native
authed request without first ensuring a bearer is attached."
