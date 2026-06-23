---
name: Lab location status mapping
description: Why lab stations carry both a free-form code and a mapped workflow stage, and what all locate flows must send.
---

# Lab location (station) status mapping

Lab `lab_locations` rows have BOTH a free-form `code` and a `status` (a valid
case-status enum value = the mapped workflow stage). Moving a case to a station
sets `case.status`, which only accepts the fixed 15-value enum
(`received, in_design, scan, in_milling, post_mill, sintering_furnace,
model_room, in_porcelain, qc, complete, shipped, delivered, on_hold, remake,
cancelled`).

**Rule:** every "locate"/move flow must send `station.status`, NEVER the
lowercased `code`. Sending `code` is what broke custom stations like "Design"
("0 updated, N failed") — the lowercased code is not a valid case-status.

**Why:** built-in stations historically had a `code` that *happened* to be a
valid enum value, so sending code worked for them but silently failed for any
admin-created custom station whose code was arbitrary.

**How to apply:**
- Create requires `status`; `code` is optional. PATCH `status` optional.
- Locate UIs (desktop cases.tsx + lists.tsx station mgmt, mobile case/[id].tsx,
  manage/locations.tsx, batch-locate, LocateCaseSheet) build picker options from
  the station list and submit `status`.
- Existing pre-column rows default to 'received'; run
  `pnpm --filter @workspace/scripts run backfill-location-status` (idempotent;
  maps code→enum, else name→built-in, else leaves 'received' + warns for admin
  review) at deploy time so existing custom stations get a real stage.
