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

**The guard must be in EVERY native request path, not just resilientFetch.**
`uploadCaseMedia` uses `XMLHttpRequest` directly (not `resilientFetch`) to avoid
Expo's fetch FormData limitation. It therefore also needed its own null-token
hydration guard: `if (!_accessToken) { loadTokens(); refreshAccessToken(); throw
if still null }`. Without this guard the same CSRF 403 trap applies — the XHR
goes out with no bearer, RN attaches a cookie, server CSRF blocks it permanently.
The thrown error propagates up to `rawUploadPhotoToCase`'s try/catch as `false`
(transient failure), so the upload retries after re-auth rather than wedging as
"rejected". Any future XHR-based upload path needs the same pattern.

**Trap: the no-bearer guard must exempt PUBLIC pre-auth endpoints.** The native
guard that throws `"Not authenticated: no bearer token available."` when no
access token is present will also block the very endpoints used to *obtain* a
token (`/api/auth/login`, `/api/auth/register`, `/api/auth/2fa/challenge`) —
they are called before any token exists. Symptom: a red "Connection error: Not
authenticated: no bearer token available.. Server: …" banner on the login
screen, surfaced because auth-context wraps the thrown error.

**Fix (implemented):** `lib/unauthenticated-paths.ts` holds an exact-match
`Set<string>` (`UNAUTHENTICATED_PATHS`) of all public endpoints. `resilientFetch`
calls `isUnauthenticatedPath(path)` before throwing; if the path is in the set,
the guard is skipped. Query strings are stripped before matching.

**Critical: use exact-match, never prefix matching.** A prefix like `/api/auth/users`
would also exempt `PUT /api/auth/users/:id/password` (authenticated!). Always
match exact path (strip query string first with `path.split("?")[0]`).

**When adding a new public endpoint:** add it to `UNAUTHENTICATED_PATHS` in
`lib/unauthenticated-paths.ts` ONLY if the server route has no `requireAuth` guard.

**Why:** the guard and the public-auth surface live in different files, so adding
or tightening one silently breaks the other.

**Rescuing already-installed apps (no app-store update):** the server cookie-gate
and the client bearer-hydrate fix only help *new* logins / *new* builds. An app
already on a user's phone keeps a stale cookie in its RN fetch jar and can't be
changed without a store update. The server-side lever that heals it: in
`requireCsrf`, when a cookie-authed unsafe request has no valid double-submit
token, allow it if it carries **neither `Origin` nor `Referer`** (native/curl/
server-to-server) and only 403 when a browser origin IS present. A browser-forged
cross-site request always carries Origin (browser-set, unsuppressable), so this
keeps web CSRF protection intact while unblocking native cookie-only POSTs. The
request still falls through to `requireAuth` (JWT/session validated), so authz is
unchanged. **Deploy note:** mobile points at prod — the fix only takes effect
after the API server is republished; stuck queue items then clear via "Retry all".
