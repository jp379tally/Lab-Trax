---
name: Profile org type field mismatch
description: canReceivePayments check in profile.tsx used wrong field name for organization type
---

The `/api/auth/me` membership response has `organization.type` (not `organization.userType`).

**Why:** The `canReceivePayments` guard in `profile.tsx` used `m.organization?.userType`, which is always `undefined` on the API response. Because the guard is `if (orgType && orgType !== "lab") return false`, a falsy `orgType` skipped the guard entirely, so provider-org owners incorrectly got `canReceivePayments = true`.

**How to apply:** When reading org type from a membership object, always use `membership.organization?.type`. The `userType` field lives on the *user* object (from `/api/auth/me` → `user.userType`), not on the nested `organization` object.

**Fix:** Changed type annotation `{ userType?: string }` → `{ type?: string }` and runtime read `m.organization?.userType` → `m.organization?.type` in profile.tsx.
