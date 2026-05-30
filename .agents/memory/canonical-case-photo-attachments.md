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

# Legacy (`lab_cases`) photos CAN be fixed server-side — separate path from canonical

**Key distinction:** The "needs a new mobile build" rule above is true ONLY for canonical (`cases` table) photos, because the app must create the `caseAttachments` row. **Legacy mobile cases (`lab_cases`) are different:** they sync the *whole* `caseData` blob (including the photo URLs) to `POST /legacy/cases`, so the server already knows which file belongs to which case. That makes a server-only fix possible — no new build.

**The mechanism (a parallel ledger, not `caseAttachments`):** `caseAttachments.caseId` FK-references canonical `cases.id`, so legacy cases can never use it. The fix introduces a separate `legacy_case_media` ledger (fileName PK → labCaseId/organizationId/ownerId) that records which legacy case owns each file. The serving route falls back to this ledger when there's no canonical attachment row, and authorizes the same way the rest of legacy access does (ownerId === user OR the case's org is in `fetchUserActiveLabIds`). The orphan cleanup must also treat ledger filenames (and live `lab_cases.caseData` filenames) as referenced, or it will trash them.

**Why first-writer-wins binding:** The ledger binds a filename to the *first* legacy case that references it (`onConflictDoNothing`). This prevents a later, crafted `caseData` from re-claiming another tenant's file. Do NOT change this to last-writer-wins — that reopens a cross-tenant media-disclosure hole.

**Production rollout without a migration:** The table is created at startup via `CREATE TABLE IF NOT EXISTS` (`ensureLegacyCaseMediaTable`) and a fire-and-forget `backfillLegacyCaseMedia` scans existing `lab_cases`, binds their files, and restores any already moved to `.trash/`. This repairs already-broken production photos on deploy. **Tradeoff to remember:** the raw DDL must stay in lockstep with the Drizzle schema definition, and if the DB role lacks DDL rights the ensure/backfill silently logs-and-skips (legacy serving stays broken until fixed) — watch for the `legacy_case_media ensure/backfill failed` log on deploy.
