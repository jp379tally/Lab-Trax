---
name: Maynard active-case context injection
description: Grounding the AI assistant in the viewed case, and the authz rule it must obey
---

# Active-case context grounding (Maynard)

The AI assistant is grounded in the case(s) the user is looking at by injecting
a bounded case summary into the system prompt (so "this case"/"these cases"
resolve without the user restating the case number). The clients already send
the case id(s); the server side must consume them.

## The non-obvious rule: match the case tools' authz exactly
Prompt-context injection is an authorization surface. It must apply the **same
tenant AND role gate** as the read-only case tools (`lookup_case`), not just
tenant scope:
- provider users: scope to their linked provider orgs (empty scope → inject
  nothing);
- lab users: enforce the lab role gate (billing/admin) *before* injecting, and
  always exclude soft-deleted rows.

**Why:** a role-restricted lab user (e.g. read-only) who is denied by the case
tools must not see case summaries leak in through prompt context. A code review
rejected a first version that had tenant scope but skipped the role check.

**How to apply:** run the org/role resolution and the case fetch inside one
try/catch that returns an empty block on ANY failure (role denial, no scope, no
rows, DB error) so a lookup problem can neither leak data nor break the chat.
Keep it bounded (cap case count + truncate long free-text fields).

## Test gotcha
Two different DB access styles are involved: the route resolves the lab org via
`db.select().from(organizationMemberships)`, but the role check
(`requireAnyRole`) uses `db.query.organizationMemberships.findFirst`. A positive
lab test must satisfy BOTH — set the membership row for org resolution AND a
`findFirst` result carrying an authorized role. A blanket mock that returns `[]`
for every `.select()` leaves the feature inert, which is why unrelated AI suites
stayed green. To prove injection, make the db mock distinguish tables by object
identity (compare the `.from(t)` arg against the real table exports).
