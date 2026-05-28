---
name: Replit proxy drops large single-shot uploads
description: Any single-shot multipart POST to the API through the Replit reverse proxy that grows past ~20–100 MB will fail with browser-level "Failed to fetch" — the connection is closed before reaching the server, so the user sees a network error and the server has no log of the request.
---

Single-shot multipart POSTs through the Replit reverse proxy fail at ~20 MB with TypeError("Failed to fetch") (i.e. ApiError status 0 from `apiFetch`), even when the route's multer `fileSize` limit is much higher (300 MB). The proxy closes the connection mid-upload, so the server never logs the request and the browser surfaces a network error with no HTTP status.

**Why:** The Replit reverse proxy enforces an undocumented request-size / connection-duration cap well below what the application's multer config would otherwise allow. We've now hit this twice — first for downloads (worked around with signed GCS URLs in `app.ts::serveInstaller`), now for uploads.

**How to apply:** Any new endpoint that ingests user-uploaded files larger than ~20 MB must NOT use single-shot multipart through the proxy. Use the existing resumable pipeline in this codebase:

- `createUploadSession` → `sendUploadChunk` (1 MB chunks) → POST `/cases/:id/attachments` with the returned `storageKey`.
- The `uploadMediaFile` helper in `DashboardDropZone.tsx` already encapsulates the >20 MB threshold + chunk loop and is the reference pattern.
- For domain endpoints that historically accepted a full archive (e.g. the iTero ZIP path), pre-extract on the client and run the per-file attachments through chunked upload instead of POSTing the archive.

POSTs are non-idempotent and `apiFetch` will NOT auto-retry them on TypeError, so a single proxy drop is a hard user-visible failure — not a transient blip to retry.
