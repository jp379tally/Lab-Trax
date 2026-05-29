---
name: Legacy mobile case blob data-loss
description: Why mobile (lab_cases) case history/photos kept collapsing to one event, and the append-only merge that fixes it.
---

# Legacy mobile case blob: history/media data loss

**Symptom (reported multiple times):** a mobile case's Case History shows only the single most-recent event, and a photo the user just took vanishes from Attachments.

**Root cause:** mobile `lab_cases` store the whole case as a JSON string in `case_data`. The mobile app's in-memory case list comes from the LIST endpoint `GET /legacy/cases`, which deliberately STRIPS `activityLog`/`photos`/`videos` to keep the payload small. When the app appends one note/photo/status entry to that stripped object and PUTs the WHOLE case back via `POST /legacy/cases`, its arrays contain only the one new item. The upsert used to blindly replace `case_data`, so every sync wiped the case's entire stored history and media down to that single entry. A later note-sync then also wiped the photo.

**Why it was misdiagnosed:** an earlier "fix" only rebuilt history for DESKTOP cases (the `cases` table, which uses `case_events`). Mobile `lab_cases` (case-number format like `26-49`, NOT `C-XXXX`) take a totally different code path and were never touched. Also: the user tests against PRODUCTION (`lab-trax.replit.app`), so their case never appears in the dev DB.

**Fix (server-side, in the `POST /legacy/cases` upsert):** inside the existing `if (lockedRow?.case_data)` block, union-merge incoming `activityLog`/`photos`/`videos` with the stored arrays (append-only, dedup by entry `id` else a content signature; media deduped by value). A stale client can now only ADD, never shrink. This fixes already-installed app builds without a new mobile build — the data is preserved, and the detail screen (`GET /legacy/cases/:id`) returns the full arrays.

**Why append-only is safe:** no mobile surface deletes individual photos/notes, so union can't resurrect an intentional deletion. **If per-entry/media delete is ever added, this merge must switch to tombstones** or it will resurrect deletions.

**Caveats:** photo THUMBNAIL rendering on mobile still needs the authed-image client code (ships only in a new EAS build); the server fix preserves the data regardless. Activity ordering relies on numeric `timestamp`.
