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
