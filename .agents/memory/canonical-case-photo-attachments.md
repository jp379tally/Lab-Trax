---
name: Canonical-case photo display requires an app-created attachment row
description: Why blank case photos on the mobile app can only be fixed app-side, never server-side
---

# Canonical-case photos: the display link must be created by the app

**Symptom:** Photos added to a case show as blank gray thumbnails (and blank on tap) in production. Production logs show `POST /api/media/upload` → 200 immediately followed by `GET /api/cases/attachment-file/<that-file>` → 404, forever, on the same persistent server instance.

**Root cause:** The serving route refuses to serve a case-media file unless a `caseAttachments` row links that file to a case the requester owns (this is a deliberate authorization/IDOR guard — see threat_model.md "Information Disclosure"). A bare `POST /api/media/upload` writes the file to `uploads/case-media/` but creates **no** attachment row, so every serve attempt 404s. The file is on disk; the *link* is missing.

**Why there is no server-side-only fix (for canonical cases):** `syncCaseToServer` in `artifacts/labtrax/lib/app-context.tsx` sends **only `{ status }`** via PATCH for canonical (`_sourceTable === "cases"`) cases — it never transmits the photo URLs. So the server can never learn which case an uploaded photo belongs to from sync. The attachment row can only be created by the app explicitly calling `POST /api/cases/:caseId/attachments` with the caseId at add-photo time. `caseAttachments` also FK-references `cases.id` (canonical), so legacy `lab_cases` photos can't use this table at all.

**Consequence:** Fixing blank canonical-case photos REQUIRES a new mobile build (the app code must create the row). No api-server deploy can retroactively repair an already-installed build. Orphaned files already uploaded by old builds have no row and cannot be recovered into the UI.

**Why:** Authorization is row-based by design; loosening the serving route to serve by filename without a row would be a cross-tenant media-disclosure vulnerability.

**How to apply:** If a user reports persistent blank photos and prior "fixed" claims didn't help, do NOT assume the code fix is wrong — verify (a) the file uploads 200, (b) the serve 404s for lack of a row, and (c) whether the user is actually running a build that contains the attachment-creation code. The blocker is usually build delivery (TestFlight), not the code. Confirm the EAS build actually completed AND submitted — the build workflow log must show submit success, not just "Build in progress…" (the workflow can be cut off mid-build, leaving nothing on TestFlight).
