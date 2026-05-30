---
name: Case media must be backed by a caseAttachments row
description: Why a bare /api/media/upload URL renders blank, and the correct upload+attach+serve flow
---

# Case media stored URLs must be backed by a caseAttachments row

The API has TWO auth-gated file-serving routes for case media:
`GET /api/cases/attachment-file/:filename` (legacy, filename-based) and
`GET /api/cases/:caseId/attachments/:attachmentId/file` (id-based). BOTH only
serve a file if a matching `caseAttachments` row exists — they look the row up
to do the case-membership/visibility auth check, then derive the on-disk path
from the row's `storageKey` (never from the URL). No row → 404.

`POST /api/media/upload` only stores the file on disk and returns a
`/api/cases/attachment-file/<filename>` URL. It creates **NO** caseAttachments
row. So storing that bare URL in `caseItem.photos[]` or an activity
`imageUri` produces a permanent blank thumbnail (404), and tapping it shows
nothing.

**Rule:** any media URL persisted for display MUST be backed by a
`caseAttachments` row. The correct flow (see `uploadPhotoAndCreateAttachment`
in `lib/app-context.tsx`): upload once → `POST /api/cases/:caseId/attachments`
with `storageKey=<uploaded url>` → store the id-based serving URL
(`/api/cases/:caseId/attachments/:id/file`) which is same-origin so
`caseMediaSource` attaches the bearer token.

**Why this was masked before:** native multipart uploads used to silently fail
(expo/fetch FormData bug) and fall back to the local `file://` uri, which
displayed on-device until reinstall. Fixing uploads exposed that the stored
server URL was never servable.

**Sync constraint:** the server `unionActivityLog` dedups by entry `id` and
keeps the FIRST occurrence (never overwrites). So you cannot optimistically
sync a `file://` entry then replace it with the canonical URL — the canonical
update is dropped. Upload+attach FIRST, then sync the entry once.

**How to apply:** when adding any photo/video/file to a canonical (`_sourceTable
=== "cases"`) case, resolve to the attachment-backed URL before writing it into
state or syncing. `addCasePhoto`/`addCasePhotosWithNote` do this.
