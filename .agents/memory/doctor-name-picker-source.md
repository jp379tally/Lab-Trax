---
name: Doctor-name picker data source
description: Where the LabTrax case/invoice "Doctor name" picker gets its options, and why not the practice doctors endpoint
---

The lab-slip / invoice "Doctor name" picker (`DoctorNamePicker`) is fed a list of
distinct doctor names derived from the lab's `/cases` list — NOT from a
practice-scoped doctors endpoint.

**Rule:** A parent that renders the case drawer or invoice editor may pass a
`doctorNames` prop. If it omits it (e.g. the dashboard's `CaseDrawer`), the
component must self-fetch `/cases` and derive distinct names as a fallback,
gated so a page that already supplies a non-empty list pays no extra request.

**Why:** `/organizations/:id/doctors` and `/organizations/:id/eligible-doctors`
are gated on lab-admin (`requireAnyRole` on the parent lab with `ADMIN_ROLES`).
Non-admin staff legitimately edit cases, so sourcing the picker from those
endpoints 403s for them and re-introduces an empty "No doctors found." picker.
The `/cases`-derived list is role-agnostic and works for everyone. This is also
why the invoice editor self-fetches `/cases` for the same purpose.

**How to apply:** Any new entry point that renders a doctor picker should either
pass a `doctorNames` list or rely on the component's `/cases` self-fetch
fallback. Do not switch the picker to the admin-gated practice doctors
endpoints.

## Merge must rewrite legacy lab_cases blobs, not just canonical rows

The picker source (`/cases/doctor-names`) unions distinct `cases.doctorName`
with names parsed out of legacy mobile `lab_cases.case_data` JSON blobs. So a
doctor merge that rewrites only canonical `cases` rows leaves the merged-away
spelling resurfacing in the picker (the symptom: practice/Customer-Center view
shows one doctor while the New-case picker shows several variant spellings).

**Rule:** doctor merge/preview/undo must ALSO rewrite `doctorName` inside
matching legacy blobs (preserving every other key), reversibly via a
`legacyMoves:[{id,before}]` snapshot in the audit metadata.

**Why:** legacy rows store the doctor name in a TEXT JSON blob, not a column,
and they have no practice/provider id — they only ever surface in the
role-agnostic picker, which is exactly where the variant-spelling complaint
comes from.

**How to apply:** parse blobs defensively (skip non-object/malformed/empty —
never throw), prefilter with `ILIKE` then confirm with a trimmed
case-insensitive exact match on the parsed name, claim each row once across
sources, and skip the legacy rewrite when source name already equals the target
(a same-name/different-practice merge has no blob dimension to disambiguate).
Undo is all-or-nothing: refuse (409) if any legacy row is missing, malformed,
or renamed away from the merge target.
