---
name: Mobile create-case required fields
description: Why the mobile create-case payload must always include a provider org and doctor name — no "unlinked"/skip path.
---

# Mobile create-case requires provider org + doctor name

The case-create endpoint hard-requires both `providerOrganizationId` and a
non-empty `doctorName`. The DB `cases.providerOrganizationId` column is
`NOT NULL` and the server create schema validates `doctorName.min(1)`. There is
**no** default/placeholder provider org to fall back to.

**Why:** A mobile Rx-review flow once shipped a "Continue without linking"
(unlinked doctor) path that omitted `providerOrganizationId`. It produced an
HTTP 400 on every Create Case — it could never succeed against the server
contract. Both manual new-case flows (mobile `new-case.tsx`, desktop
`NewCaseModal`) already make practice selection mandatory for the same reason.

**How to apply:** On any mobile case-create surface, gate submit on a selected
practice AND a non-empty doctor name (prompt the user instead of submitting).
Do not reintroduce a skip/optional-provider path unless the server schema and
the `NOT NULL` DB column are changed first (and even then, mind the
nullable-FK cascade noted in mobile-invoice-nullable-provider-org.md).
