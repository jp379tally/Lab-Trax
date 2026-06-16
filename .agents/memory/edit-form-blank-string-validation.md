---
name: Edit forms PATCH blank strings into format-validated fields
description: Why optional Zod fields with format validators (.email() etc.) must accept "" on update endpoints used by full-record edit forms
---

# Edit forms PATCH the whole record, including blank strings

The desktop (and mobile) edit forms POST/PATCH their **entire** local form
state back to the API, not just the changed fields. Empty inputs are sent as
`""`, not omitted. (Create flows often omit blanks, so the bug only shows on
edit.)

**Rule:** Any optional field on a shared update schema that has a *format*
validator — `.email()`, `.url()`, regex, etc. — must also accept `""` (and
ideally normalize it to `null`), or editing a record where that field is blank
fails Zod validation.

**Why:** `z.string().email().optional()` rejects `""` because `.optional()`
only allows `undefined`, not empty string. The API's error handler
(`artifacts/api-server/src/app.ts`) maps every ZodError to a generic
400 `"Invalid request."`, so the real cause is invisible to the user — it just
looks like a mystery gating/save bug. This bit the org `billingEmail` field on
`PATCH /api/organizations/:id`.

**How to apply:** Pattern that works and survives `.omit().partial()` when one
schema derives from another:
`z.union([z.literal(""), z.string().email()]).transform(v => v === "" ? null : v).optional()`.
Fix at the **server schema** layer (shared by desktop + mobile), not per client.
