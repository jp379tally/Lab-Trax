---
name: Expo native multipart upload
description: Why file/photo uploads fail with expo/fetch and how to upload reliably on RN + web
---

# Expo native multipart upload

`expo/fetch` (the `import { fetch } from "expo/fetch"` used to build the app's
`resilientFetch`) does NOT accept React Native's native file descriptor
`{ uri, name, type }` as a FormData part. Appending one and POSTing it throws
the runtime error **"Unsupported FormDataPart implementation"** — this is the
root cause of "Upload Failed" when attaching photos/files in the mobile app.

**Rule:** never route multipart file uploads through `resilientFetch` /
`expo/fetch`. Use the XHR-based `uploadCaseMedia()` helper in
`lib/query-client.ts` instead. XHR uses RN's own networking + Blob module,
which fully supports `{ uri, name, type }` on native and a `Blob` on web, and
is immune to whichever `fetch` implementation is active.

**Why XHR over `globalThis.fetch`:** `globalThis.fetch` happens to work on
native today, but is fragile to future polyfills/overrides. XHR is the
battle-tested RN upload path. Do not set `Content-Type` manually — the runtime
adds the multipart boundary. Rebuild the FormData on each retry (a consumed
Blob can't be re-sent). The mobile app authenticates with bearer tokens, so a
401→refresh-token retry is sufficient; cookie-session refresh is not needed.

## Related: case detail screen must UNION its two case views

`app/case/[id].tsx` holds two views of the same case: the live in-memory case
(`cases.find(...)`, updated instantly on every note/photo/barcode/station
change) and `fullCaseData`, a heavier server snapshot fetched **once on mount**.
Building `caseItem` as `fullCaseData.x ?? base.x` masks every event/photo added
*after* mount until the next refetch — that was the "events/photos not showing
up in Case History" bug. Union both (append-only, dedup by `id` then a content
signature, mirroring the server's `unionActivityLog`).
