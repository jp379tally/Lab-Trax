---
name: iTero is a parallel case-create path
description: Cross-cutting case-creation features must be threaded through the iTero import endpoint separately from the generic /cases path.
---

# iTero is a separate, parallel case-create path

LabTrax has multiple independent case-creation entry points, NOT one. The main
ones:
- canonical `POST /cases` (generic create + generic/Shining ZIP import client branch)
- `POST /cases/import-from-itero-rx` (iTero ZIP import — its own handler + its own Zod body schema)
- there is also a separate `import-from-itero-zip` handler and a single-file poller route

**Rule:** any cross-cutting case-creation feature (remake linking, restoration
restoration, object-storage media mirroring, pricing/no-charge, etc.) must be
implemented in EACH path. Fixing it in the generic /cases path does NOT fix the
iTero path.

**Why:** this has bitten repeatedly. Remake linking was fixed for the generic
ZIP path, then had to be re-fixed for the iTero ZIP path (which silently created
unlinked cases). Same pattern as the object-storage mirror gap (see
`itero-rx-object-storage-mirror.md`) and the iTero restoration gaps (see
`itero-import-restoration-gaps.md`).

**How to apply:**
- The iTero endpoint receives input as **multipart FormData**, not JSON. Booleans
  must be string-encoded — e.g. `remakeCharged` is `z.enum(["true","false"])`,
  not `z.boolean()`. The desktop client appends them to FormData
  (`fd.append("remakeCharged", x ? "true" : "false")`).
- Reusable server helpers exist and should be reused across paths:
  `resolveRemakeOriginal()` (resolves canonical OR legacy lab_cases original,
  blocks cross-tenant) and `writeReciprocalRemadeBy()` (writes the `remade_by`
  event for canonical, patches lab_cases activityLog blob for legacy — the legacy
  branch must run AFTER the Drizzle tx commits, since lab_cases can't join the tx).
- Remake suffix (B, C, …) is computed inside the tx under
  `pg_advisory_xact_lock(1742068800, hashtext(originalId))` then counting
  non-deleted cases with that `remakeOfCaseId`; this replaces the generated case
  number entirely.
- No-charge remake: still create the draft invoice, but zero every line item and
  attach a no-charge note (don't skip invoice creation).
