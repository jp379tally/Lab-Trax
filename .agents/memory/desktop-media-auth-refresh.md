---
name: Desktop media fetch must refresh on 401
description: Why raw bearer fetches for case media go blank after token expiry, and the isSameApiOrigin bug in web mode.
---

# Desktop/web media fetches must use `authedFetch`

In `artifacts/labtrax-desktop`, the JSON data layer (`apiFetch`) transparently does
**401 → `refreshAccessToken()` → retry**. Access tokens have a **15-minute TTL**.
Any media/file fetcher that does a one-shot raw `fetch()` with the in-memory bearer and
**no refresh-on-401** will return blank images/scans/files once the token ages past 15 min.

**Critical bug in web/dev mode (`isSameApiOrigin`):** when `VITE_API_BASE_URL` is empty,
`getApiOrigin()` returns `""`. `new URL("")` throws, so `isSameApiOrigin` always returns
`false` → auth is NEVER added to relative `/api/…` URLs → every media fetch 401s → blank.
Fix: relative URLs (no `://`) are always same-origin; empty API origin = compare against
`window.location.origin`. Both cases are now handled in `AuthedMedia.tsx`.

**Rule:** route all same-origin bearer-gated media/file fetches through the exported
`authedFetch(url, signal?)` in `src/lib/api.ts` (awaits `waitForTokenHydration()`,
attaches bearer, refreshes+retries once on 401). `AuthedImage` / `AuthedVideo` already
do this via `useAuthedObjectUrl`. Cross-origin URLs must use plain `fetch` — never attach
the bearer to a third-party host.

**Why:** symptom looks like a server regression, but is a client-side auth failure:
in Electron the absolute URL origin-match works; in web mode it silently skips auth.

**How to apply:** when adding any new media fetch, scan-viewer download, or attachment
open, use `authedFetch`. Grep for raw `getAccessToken()` + `fetch(` to catch regressions.
