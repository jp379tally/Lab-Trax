---
name: Desktop media fetch must refresh on 401
description: Why raw bearer fetches for case media go blank after token expiry, and the required helper.
---

# Desktop/web media fetches must use `authedMediaFetch`

In `artifacts/labtrax-desktop`, the JSON data layer (`apiFetch` / `apiFetchArrayBuffer`)
transparently does **401 → `refreshAccessToken()` → retry**. Access tokens have a
**15-minute TTL** (`ACCESS_TOKEN_TTL="15m"` in api-server). Any media/file fetcher that
does a one-shot raw `fetch()` with the in-memory bearer and **no refresh-on-401** will
return blank images/scans/files once the token ages past 15 min — while all text/data
keeps loading, because those calls silently refresh. The pre-handler 401 is ~1ms, so it
is NOT a serving-logic bug; it is purely missing token refresh on the client.

**Rule:** every same-origin, bearer-gated media/file fetch in the desktop client must go
through the exported `authedMediaFetch(url, init?)` in `src/lib/api.ts` (awaits
`waitForTokenHydration()`, attaches `authHeader()`, refreshes+retries once on 401).
Cross-origin URLs must use a plain `fetch` with **no** bearer (never leak the token to a
third-party host).

**Why:** symptom is misleading — "photos broke after a republish" looks like a server/deploy
regression, but the republish just reset the clock so the user freshly crossed 15 min.

**How to apply:** when adding any new `<AuthedImage>`-style fetch, scan-viewer download,
or attachment open/download, route it through `authedMediaFetch`. Grep for raw
`fetch(... Authorization: Bearer` / `getAccessToken()` + `fetch(` to catch regressions.
