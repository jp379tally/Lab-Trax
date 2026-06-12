---
name: Registering a lab owner for e2e
description: Why a freshly registered "lab" user can fail every EDIT_ROLES gate in tests
---

To get a user that passes the mobile EDIT_ROLES gates (Lists/Pricing/Reports edit
affordances, `editableLabMemberships` in `lib/auth-me.ts`), `POST /api/auth/register`
must create an **active owner lab membership** — and it only does so when the body
includes a non-empty `practiceName` **and** `createOrganization:true` **and**
`userType:"lab"` (or `"provider"`).

**Why:** the register handler computes `shouldCreateOrganization` from all three.
Omit `practiceName` and you get a user with `user_type=lab`, `role=user`, and **no
`lab_memberships` row at all**. The global `users.role` is always `"user"` on
register by design (ownership lives in the membership, not the user row), so every
edit gate that keys off an active owner/admin/billing membership reads as
no-access and the screen shows the friendly "Not available" locked state — which
looks exactly like a gating bug but is a missing-membership test-setup mistake.

**How to apply:** when scripting an owner account for an e2e, always send
`{username,password,userType:"lab",createOrganization:true,practiceName:"…"}`.
Verify with `select role,status from lab_memberships …` (table is `lab_memberships`,
the join column is `lab_id`, not `organization_id`).
