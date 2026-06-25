---
name: Stale prod API after merge
description: A merged server fix is not live until the API server is re-published; how to verify the deployed server version.
---

A merged code fix is NOT live in production until the **API server is re-published**.
Mobile (TestFlight/EAS) and desktop builds ship on their own cadence and all talk to
the same live API at the prod domain (e.g. `https://lab-trax.replit.app`). The live
server can lag the repo by many commits even though the mobile build is current.

**Why:** A user-reported TestFlight bulk-locate bug persisted after the server-side
fix was merged, because the API server was never re-deployed — the mobile build
carried the client half of the fix but hit a stale server missing the server half.

**How to apply (verify deployed server version without guessing):**
- Find a discriminator that changed between the old and new server code — ideally a
  field that lands in durable storage or logs. Here it was the `audit_logs`
  metadata field name for `cases_bulk_status_changed`: old code wrote
  `skippedLegacyCount`, the fix renamed it to `legacyCount`.
- Query the **production** DB read-only (`executeSql` `environment:"production"`) or
  inspect deployment logs for that discriminator. Old shape present → prod is stale.
- Also check `getDeploymentInfo()` for `deploymentType` / `hasSuccessfulBuild`.
- The corrective action is a **Publish**, not a code change. Run the
  REGRESSION_GUARDRAILS pre-release checklist first (project policy).
