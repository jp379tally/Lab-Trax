---
name: Legacy/providerless doctor names source
description: Where "unassigned/legacy" doctor names actually come from in LabTrax, and why the canonical-NULL-provider path is dead.
---

`cases.provider_organization_id` is `.notNull()` in the schema, so a canonical case can NEVER be providerless. Any feature framed around "providerless canonical cases" (e.g. an "Unassigned / legacy doctor names" bucket) must source those names from legacy `lab_cases` JSON blobs (`caseData.doctorName`), which carry no provider concept at all.

**Why:** The `GET /cases/legacy-doctor-directory` endpoint and its tests were first written to insert canonical cases with a NULL provider; that violates the NOT NULL constraint at insert time. The dashboard drop-zone picker (`/cases/doctor-names`) unions canonical + legacy names, so a name that shows in the picker but NOT in Customer Center is a legacy-blob-only name.

**How to apply:** When surfacing/merging "unassigned" doctor names, drive the data off `lab_cases` blobs (and dedupe against provider-attached canonical names). A `cases.providerOrganizationId IS NULL` query is harmless but always empty — keep it only as defensive documentation, and never write a test that inserts a NULL-provider canonical case.
