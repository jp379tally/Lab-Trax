---
name: Mobile invoice nullable providerOrganizationId
description: When making invoices/credits.providerOrganizationId nullable for legacy mobile cases, every downstream consumer in invoices.ts and statements.ts needs a null guard.
---

## Rule

Mobile cases (in `lab_cases`) have no provider org. Making `invoices.providerOrganizationId` nullable
requires guarding **every** downstream consumer — not just the insert site.

**Why:** TypeScript finds the insert error, but `string | null` silently bleeds into
`eq(organizations.id, ...)`, `requireMembership(userId, ...)`, and statement-grouping loops that call
`.filter((id) => ...)` — those only fail at runtime or typecheck if you catch them all.

**How to apply:** After any schema column goes from `.notNull()` → nullable, run typecheck immediately
and fix all `TS2769` / `TS2345` errors before committing. Key patterns to search for:
- `eq(table.col, nullableField)` → guard with `if (!nullableField) ...` before the call
- `requireMembership(userId, nullableField)` → make it conditional: `nullable ? await ... : null`
- `.filter((id) => condition)` on a nullable array → use type predicate `(id): id is string => id !== null && condition`
- Statement-grouping loops: add `if (!id) continue` before the filter check

Also: `invoiceCredits.providerOrganizationId` inherited the same NOT NULL, so it needed the same nullable
treatment when invoices became nullable.
