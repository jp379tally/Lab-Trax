---
name: lab-team pendingInvites are unscoped
description: Which endpoint to use for sender-side invite listings (per-org vs lab-team)
---

`GET /api/auth/lab-team` returns `pendingInvites` aggregated across ALL labs the caller administers, ignoring the `?orgId=` filter, and each row carries no lab/organization id. For any per-organization sender-side invite listing, use `GET /api/organizations/:orgId/invites` instead (admin-gated, properly scoped, includes `organizationId` + `lastEmailStatus`/`lastEmailError`/`lastEmailAttemptAt` delivery fields; filter to `status === "pending"` client-side).

**Why:** A multi-lab admin would otherwise see another lab's invites in a per-org card, and there is no field to filter them client-side.

**How to apply:** Mobile OrgCard invites use the org-scoped endpoint. Desktop settings.tsx still reads lab-team `pendingInvites` (fine while desktop shows a single-lab settings page, but a known gap if it ever supports multi-lab admins).
