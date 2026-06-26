---
name: Practice-not-showing-in-Customer-Center is a publish gap, not a code bug
description: Recurring "I added a practice but it doesn't show in Customer Center" reports are almost always a stale-prod / stale-client deploy gap; diagnose via prod DB before touching code.
---

# "Added a practice but it won't show up" = publish gap

When a lab admin reports a newly-added provider practice not appearing in
Customer Center (or the Practices page), **check the production database
first — do not assume a code bug.** This has recurred for multiple practices
(e.g. a "Dr. Nancy E. Phillips, DDS" report, then three near-duplicate
"Susan Byrne" entries the user re-created because the first never showed).

## The mechanism
- Provider creates **intentionally do not create a `lab_memberships` row** for
  the creator (a lab admin should not become a "member/owner" of every practice
  they add). So newer practices have **no membership row** for the creator.
- Visibility of those membership-less practices to a lab admin depends ENTIRELY
  on the `includeLabPractices` query path being live on BOTH surfaces:
  - server `GET /organizations?includeLabPractices=true` (collects provider
    practices under labs where the caller has an active admin/owner membership),
  - the client (Customer Center + Practices page) actually sending the param.
- These two halves (stop-membership-on-create vs. includeLabPractices visibility)
  shipped in **separate commits**. If prod has the first but not the second,
  every membership-less practice is invisible — looks exactly like a gating bug.

## Diagnose (read-only) before changing anything
Query the **production** DB (`executeSql … environment:"production"`):
1. The practice exists, `is_active=t`, `deleted_at IS NULL`, `type='provider'`,
   `parent_lab_organization_id` = the user's lab. → data is fine.
2. The creator has an active **owner/admin** membership in that lab
   (table is `lab_memberships`, join col `lab_id`). → user is authorized.
3. The new practice has **no** `lab_memberships` row for the creator, while
   *older* practices under the same lab **do**. → confirms the publish-gap shape.
If all three hold, the repo code is correct and the fix simply isn't deployed.

## Fix
**Publish, don't patch.** Two surfaces can be stale independently:
- Production API server + web client → one Replit deploy (Publish).
- Installed Electron desktop app → needs a fresh installer build/publish;
  it auto-updates from `/downloads/latest.yml`. Web/PWA users get it from the
  Publish directly.
Check the prod published desktop version (`system_settings`, installer markers)
to know whether the desktop also predates the fix.

**Why:** the code is provably correct (`ADMIN_ROLES` includes `owner`, server
returns the rows, both client pages send `includeLabPractices`). Rewriting it,
or making the server include practices in the *default* `/organizations`
response, risks regressing the org switcher / Settings→Organizations (those
expect membership-only orgs) for zero benefit — the real gap is deployment.

**How to apply:** for any "practice/customer not showing" report, run the
3-step prod-DB check above first; only consider code changes if a practice is
genuinely missing, deleted, mis-parented, or the creator lacks admin membership.
