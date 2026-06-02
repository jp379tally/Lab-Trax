---
name: Legacy-photo synthetic attachment ids must be resolved in the file-serving route
description: Why legacy mobile-case photos 404 on desktop/web even when the file exists durably
---

# Legacy-photo synthetic ids 404 on the id-based serving route

**Symptom:** Mobile photos on a LEGACY case (`lab_cases` row) render blank on the
desktop/web client, while the SAME bytes serve 200 via
`GET /api/cases/attachment-file/<filename>`. Production logs show
`GET /api/cases/<caseId>/attachments/legacy-photo-<caseId>-<idx>/file` → 404
forever.

**Root cause:** The case-detail transform projects each `lab_cases`
`photos[]`/`videos[]` entry into a synthetic attachment with id
`legacy-photo-<caseId>-<idx>` / `legacy-video-<caseId>-<idx>`. These ids have
**no `case_attachments` row** (that table FKs canonical `cases.id`). The
desktop/web client (`AuthedImage`) renders attachments through the id-based route
`GET /:caseId/attachments/:attachmentId/file`, which looked the id up in
`case_attachments` only → null → 404, regardless of whether the file is durable
in object storage. The `/attachment-file/:filename` route worked because it falls
back to the `legacy_case_media` ledger; the id-based route had no such fallback.

**Fix:** In the id-based route, detect synthetic `legacy-(photo|video)-<caseId>-<idx>`
ids (require the embedded caseId to equal the route param), load the `lab_cases`
row, map `idx`→filename from its `photos[]`/`videos[]`, then **delegate the serve
to `serveLegacyCaseMediaFile`** (NOT a bare filename stream).

**Why the ledger delegation is mandatory (security):** authorizing only against
the *requesting* case and then streaming by filename is a confused-deputy / IDOR:
a user can craft their OWN legacy case whose `photos[]` references another
tenant's filename. `serveLegacyCaseMediaFile` re-authorizes the *file* against the
`legacy_case_media` ledger (first-writer-wins: `binding.ownerId === userId` OR
active member of `binding.organizationId`), which is the authoritative tenant
binding. Keep a case-level owner/lab-member pre-check as defense-in-depth, but the
ledger check is what actually prevents cross-tenant disclosure. Regression test:
crafted stranger-owned case referencing the owner's filename must return 403.

**Two independent failure modes — don't conflate:** (1) this id-resolution gap
(fixable server-side, helps NEW + durable files); (2) durability — files uploaded
by pre-object-storage builds to autoscale ephemeral disk are permanently gone and
404 no matter what. A mix of 404s + one 200 for the same case usually means
old-files-gone, not a code bug.

**How to apply:** when any serving route looks up attachments by id, remember
legacy cases surface *synthetic* ids with no DB row — resolve them from the
`lab_cases` blob and authorize the file via `legacy_case_media`, never by the
caller-supplied case alone.
