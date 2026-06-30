---
name: Case History note-body rendering & privacy
description: How the Case History timeline renders note_added bodies and the cross-surface rule that keeps internal lab-only note text from leaking to providers.
---

# Case History note bodies (timeline)

`note_added` history events embed the note body in their metadata as
`noteText` plus a stable `noteId`. The History timeline renders the body inline
(separate from the visibility label). There are FIVE render surfaces that must
stay in lockstep:

- desktop/web on-screen (artifacts/labtrax-desktop/src/pages/cases.tsx — reference impl)
- desktop/web print (artifacts/labtrax-desktop/src/lib/print.ts)
- mobile on-screen (artifacts/labtrax/app/case/[id].tsx)
- mobile print (artifacts/labtrax/lib/printCaseHistory.ts)
- server response shaping (artifacts/api-server/src/routes/cases.ts GET /:caseId)

## The privacy rule (why this isn't just a render bug)

Notes carry `internal_lab_only` / `shared_with_provider` visibility, exactly like
attachments. A provider (non-lab viewer) must never see internal note text.

**Server:** GET /:caseId strips it three ways for non-lab viewers via
`visibleNotesFor` (notes array) and `sanitizeNoteEventsFor` (removes
noteText/note/description from internal_lab_only note_added event metadata). The
`caseNotes` Rx-fallback summary must be built from the *visible* notes, not the
raw enriched notes, or it re-leaks the body through a different field. Mirror
`visibleAttachmentsFor` — same shape, same call sites.

**Client (defense in depth):** the on-screen/print body resolvers look the body
up by `noteId` against the viewer's visible-notes map FIRST. If the noteId is
present but absent from that map, return null — never fall back to raw metadata
`noteText`. This means even if a stale body lingers in event metadata the client
withholds it. Only fall back to metadata text when there is no noteId at all
(legacy events).

**How to apply:** any new note-history feature, or any change to the note create
path's event metadata, must be threaded through all five surfaces together, and
the noteId-absence withhold must be preserved on both clients.
