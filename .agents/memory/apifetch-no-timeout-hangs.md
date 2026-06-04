---
name: apiFetch has no request timeout (desktop)
description: Why mutating flows in labtrax-desktop can hang the UI forever, and the convention to bound them client-side.
---

# apiFetch has no request timeout — bound long-running mutations yourself

`apiFetch` in `artifacts/labtrax-desktop/src/lib/api.ts` does NOT set any
request timeout/abort. Only the internal token-refresh call has its own 15s
AbortController. So any mutating flow that `await`s apiFetch and gates a
spinner/state on it will hang **forever** if the server/proxy stalls
(zombie/restarting API instance, dropped multipart, captive portal, etc.) —
the await neither resolves nor rejects, so the spinner never clears and no
recoverable error is shown.

**Symptom seen:** case-drawer Files-tab drag-drop upload stuck on
"Uploading…" indefinitely.

**Rule:** when an apiFetch mutation drives a loading state the user is
waiting on, pass a caller-owned `AbortController` + `setTimeout(...abort())`
and map `err.name === "AbortError"` to a clear "timed out" message.

**Why this is safe:** `fetchWithRetry` rethrows `AbortError` and never
retries non-idempotent methods (POST/PATCH/PUT/DELETE), so aborting can't
duplicate a side effect. `signal` is forwarded through `RequestInit`.

**Also note:** the case-drawer upload always uses single-shot
`/media/upload`; large files should use the resumable
`/media/upload-session` path (see `uploads-context.tsx` /
`DesktopFileDropZone.tsx`). The single-shot proxy drop is a separate
known issue (see `replit-proxy-upload-limit.md`).
