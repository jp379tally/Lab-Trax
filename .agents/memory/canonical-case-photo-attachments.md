---
name: Canonical-case photo display requires an app-created attachment row
description: Why blank case photos on the mobile app can only be fixed app-side, never server-side
---

# Blank photos have THREE distinct root causes — rule each out separately

When triaging "case photos are blank," the cause is one (or more) of three independent layers. A perfect fix in one layer still leaves photos blank if another is broken:
1. **Authorization** — no `caseAttachments` row (canonical) or `legacy_case_media` ledger row (legacy) → serve 404s. (sections below)
2. **Durability** — bytes never mirrored to object storage; ephemeral/redeploy disk wipe → serve 404s even with a valid row. (section below)
3. **Client image-auth token timing** — the file request reaches the server but 401s because the native client sent no/stale bearer; image renders blank. (next section)

# Client-side cause: native <Image> sends the bearer token synchronously, with no 401 retry

**Symptom that fingerprints THIS layer:** case *history/notes* (JSON) loads fine but *every* photo is blank with "Failed · Retry", and the server/data are provably healthy (file serves 200 when you replay the request with a fresh token). Reinstalling/rebuilding does not help because the code is byte-identical across builds — it is pre-existing, not a build regression.

**Root cause:** expo-image attaches the auth header synchronously from the in-memory access token at render time (via `caseMediaSource()` → `getAccessToken()`). If that in-memory token is missing (cold start before `loadTokens()` ran) or expired, the image file request goes out unauthenticated/stale, 401s, and expo-image renders blank with **no retry**. This is the asymmetry that explains "history recovers but photos don't": `resilientFetch` (JSON) hydrates+refreshes+retries on 401; raw `<Image>` requests never did.

**Why:** image-load failures are terminal in expo-image — there is no built-in refresh-and-retry like the fetch wrapper has. Token availability is a *timing* property (memory may not be hydrated yet), independent of authorization rows and byte durability.

**The fix pattern:** wrap auth-gated media in a self-healing component (`AuthedImage`) that, on load error, force-refreshes the token once (hydrate from secure store if empty, then rotate) and forces an expo-image reload with fresh headers (recompute the source + bump `recyclingKey`). Gate the retry to first-party media only (`isCaseMediaUrl`) so third-party/broken URLs don't trigger pointless token churn, make it one-shot per URI, and reset the one-shot when the URI changes (lists reuse instances via `key={idx}`). The shared refresh already de-dupes concurrent calls, so a grid of failing images triggers a single token refresh.

# Canonical-case photos: the display link must be created by the app

**Symptom:** Photos added to a case show as blank gray thumbnails (and blank on tap) in production. Production logs show `POST /api/media/upload` → 200 immediately followed by `GET /api/cases/attachment-file/<that-file>` → 404, forever, on the same persistent server instance.

**Root cause:** The serving route refuses to serve a case-media file unless a `caseAttachments` row links that file to a case the requester owns (this is a deliberate authorization/IDOR guard — see threat_model.md "Information Disclosure"). A bare `POST /api/media/upload` writes the file to `uploads/case-media/` but creates **no** attachment row, so every serve attempt 404s. The file is on disk; the *link* is missing.

**Why there is no server-side-only fix (for canonical cases):** `syncCaseToServer` in `artifacts/labtrax/lib/app-context.tsx` sends **only `{ status }`** via PATCH for canonical (`_sourceTable === "cases"`) cases — it never transmits the photo URLs. So the server can never learn which case an uploaded photo belongs to from sync. The attachment row can only be created by the app explicitly calling `POST /api/cases/:caseId/attachments` with the caseId at add-photo time. `caseAttachments` also FK-references `cases.id` (canonical), so legacy `lab_cases` photos can't use this table at all.

**Consequence:** Fixing blank canonical-case photos REQUIRES a new mobile build (the app code must create the row). No api-server deploy can retroactively repair an already-installed build. Orphaned files already uploaded by old builds have no row and cannot be recovered into the UI.

**Why:** Authorization is row-based by design; loosening the serving route to serve by filename without a row would be a cross-tenant media-disclosure vulnerability.

**Robust client routing (flag-independent):** Mobile write routing (status PATCH, photo attach, note post) must NOT depend solely on the cached `_sourceTable` flag — local caching/merge can drop it, misrouting a canonical case to the legacy endpoint (POST /legacy/cases → 403). Use `isCanonicalCase()` in `data.ts`: trust `_sourceTable` when present, else fall back to id shape — canonical `cases.id` is always a `gen_random_uuid()` UUID, legacy `lab_cases.id` is `generateId()` (timestamp+base36, never a UUID). Safe because the server's `PATCH /api/cases/:id` and `POST /api/cases/:id/attachments` both transparently accept legacy ids.

**How to apply:** If a user reports persistent blank photos and prior "fixed" claims didn't help, do NOT assume the code fix is wrong — verify (a) the file uploads 200, (b) the serve 404s for lack of a row, and (c) whether the user is actually running a build that contains the attachment-creation code. The blocker is usually build delivery (TestFlight), not the code. Confirm the EAS build actually completed AND submitted — the build workflow log must show submit success, not just "Build in progress…" (the workflow can be cut off mid-build, leaving nothing on TestFlight).

# Legacy (`lab_cases`) photos CAN be fixed server-side — separate path from canonical

**Key distinction:** The "needs a new mobile build" rule above is true ONLY for canonical (`cases` table) photos, because the app must create the `caseAttachments` row. **Legacy mobile cases (`lab_cases`) are different:** they sync the *whole* `caseData` blob (including the photo URLs) to `POST /legacy/cases`, so the server already knows which file belongs to which case. That makes a server-only fix possible — no new build.

**The mechanism (a parallel ledger, not `caseAttachments`):** `caseAttachments.caseId` FK-references canonical `cases.id`, so legacy cases can never use it. The fix introduces a separate `legacy_case_media` ledger (fileName PK → labCaseId/organizationId/ownerId) that records which legacy case owns each file. The serving route falls back to this ledger when there's no canonical attachment row, and authorizes the same way the rest of legacy access does (ownerId === user OR the case's org is in `fetchUserActiveLabIds`). The orphan cleanup must also treat ledger filenames (and live `lab_cases.caseData` filenames) as referenced, or it will trash them.

**Why first-writer-wins binding:** The ledger binds a filename to the *first* legacy case that references it (`onConflictDoNothing`). This prevents a later, crafted `caseData` from re-claiming another tenant's file. Do NOT change this to last-writer-wins — that reopens a cross-tenant media-disclosure hole.

**Production rollout without a migration:** The table is created at startup via `CREATE TABLE IF NOT EXISTS` (`ensureLegacyCaseMediaTable`) and a fire-and-forget `backfillLegacyCaseMedia` scans existing `lab_cases`, binds their files, and restores any already moved to `.trash/`. This repairs already-broken production photos on deploy. **Tradeoff to remember:** the raw DDL must stay in lockstep with the Drizzle schema definition, and if the DB role lacks DDL rights the ensure/backfill silently logs-and-skips (legacy serving stays broken until fixed) — watch for the `legacy_case_media ensure/backfill failed` log on deploy.

# The REAL prod blocker for blank photos: autoscale ephemeral disk, not authorization

**This is the lesson the ledger/attachment-row analysis above missed.** Local disk is **not durable** regardless of target: even on `deploymentTarget = "vm"` (Reserved VM, the current `.replit` setting — it is NO LONGER autoscale) the disk is wiped on every **redeploy**. On autoscale it was additionally per-instance/ephemeral. Either way, files written to `uploads/case-media/` (and `.trash/`) cannot be relied on after a redeploy. Smoking gun in deployment logs: a file uploaded days ago 404s persistently; verify with `openCaseMediaObjectStream(<filename>)` against the bucket — if it returns null the bytes were never mirrored and the disk copy is gone.

**Why every prior fix "failed":** Both authorization layers (canonical `caseAttachments` row AND the legacy `legacy_case_media` ledger) are *necessary but not sufficient*. Even a perfect row 404s because the bytes aren't on the serving instance. Durability is a **separate** problem from authorization — you must fix both.

**The durability fix:** App Storage (object storage) is provisioned (`PRIVATE_OBJECT_DIR` set) and `case-media-object-storage.ts` has `writeCaseMediaToObjectStorage` / `openCaseMediaObjectStream`; the serving route falls back to object storage. Both mobile upload routes — `POST /media/upload` (multer diskStorage) and the resumable `PATCH /media/upload-session` finalize (fs rename) — now mirror to object storage, **awaited before returning success**, returning 500 if the durable write fails (never hand back a URL that will 404). **Silent-skip foot-gun (closed):** the mirror used to run only `if (caseMediaObjectStorageAvailable())` and otherwise silently returned a disk-only URL — that is exactly how a batch of prod photos was lost (uploaded before storage was provisioned, then a redeploy wiped the disk). Both routes now FAIL LOUDLY (500 "Media storage is not configured") when storage is unavailable instead of returning a phantom URL. Server-generated media in `cases.ts` (iTero/Rx/ZIP imports) mirror **best-effort** (`.catch` only) — acceptable since those can be regenerated.

**Why:** On ephemeral multi-instance infra, local disk is a cache, not storage. Any user-uploaded asset that must survive a redeploy or be served by a different instance MUST go to object storage synchronously on upload.

**How to apply:** When debugging "uploaded file 404s" on a Replit deployment, FIRST check `deploymentTarget` in `.replit`. If `autoscale` (or any ephemeral/multi-instance target), confirm the upload path persists to object storage before suspecting authorization. Files uploaded by *old* builds to already-wiped ephemeral disk are gone — only durable going forward (unless the app re-uploads from device-local copies on next sync).
