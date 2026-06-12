---
name: LabTrax mobile manage-screen RBAC gating
description: Which roles can edit mobile Pricing/Lists/Reports and why the gate must mirror the server, not desktop UI.
---

# Mobile Pricing / Lists / Reports edit gating

The mobile (`artifacts/labtrax`) manage screens must gate edit affordances on the
**server's RBAC**, not on desktop's UI gating. Desktop's `isAdmin` is a
platform-level `user.role === "admin"` flag — a different concept from lab
*membership* role — so copying desktop UI gating gives the wrong answer.

Server contract (artifacts/api-server `lib/rbac.ts` + route guards):
- `ADMIN_ROLES = [owner, admin]`, `BILLING_ROLES = [owner, admin, billing]`.
- pricing.ts `resolveLabId` → owner/admin ONLY. So GET tiers, GET overrides,
  GET billed, and ALL pricing writes are **admin-only**.
- GET item-labels = any member; **PUT item-labels = admin-only**.
- finance.ts vendors + categories (GET/POST/PATCH/DELETE) = **billing**.

Resulting mobile model:
- **Pricing** = admin-only screen.
- **Reports** (billed) = admin-only screen.
- **Lists** = billing for Vendors/Categories; **Item Label edit = admin-only**
  (rows read-only for billing users).

**Why:** the first review rejected gating pricing on billing — billing users saw
edit UI then got 403 because the data is admin-only. Non-eligible roles are
intentionally **blocked** ("Not available"/403), NOT shown read-only, because the
server refuses to return the underlying data to them, so a read-only view is
impossible.

**How to apply:** helpers live in `lib/auth-me.ts`
(`canAdminAnyLab`/`primaryAdminLabOrgId` for admin screens,
`canEditAnyLab`/`primaryLabOrgId` for billing). `more.tsx` uses `requiresAdmin`
vs `requiresEdit` so the menu never links to a dead-end blocked screen.
`lib/__tests__/role-parity.test.ts` anchors mobile ADMIN_ROLES/EDIT_ROLES to the
server rbac sets — if the server role sets change, that test fails.
