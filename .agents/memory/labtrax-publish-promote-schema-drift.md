---
name: LabTrax publish promote-phase failure = dev/prod schema drift
description: How to diagnose a LabTrax production publish that fails after a fully-successful build, and the correct (non-DDL) fix.
---

When a LabTrax publish fails but the build logs show every artifact built and
layers pushed ("Created hosting layer"), the failure is in the **promote**
phase (new container start / `/api/healthz` startup probe), not the build.

Runtime/promote logs are usually **not retained** (fetch_deployment_logs returns
nothing), so don't expect a stack trace. Diagnose by comparing schemas instead.

**First thing to check: dev→prod schema drift.** Post-merge applies schema to the
**development** DB only (`push-force`); production only gets schema changes when
the user clicks **Publish** (Replit diffs dev vs prod and applies it). So a freshly
merged column/table exists in dev but not prod until the next successful publish.

Diff with read-only queries:
`executeSql(information_schema.columns ... )` for `environment:"development"` vs
`"production"` and set-diff the `table.column` lists.

**Fix = re-publish.** The Publish flow applies the missing dev→prod diff. Additive
columns with a default (e.g. `status text NOT NULL DEFAULT '...'`) apply cleanly
with no rename/drop confirmation and no data loss. **Why:** prod schema is owned by
the Publish flow — never hand-write prod DDL, deploy-build `db:push`, or startup-time
`CREATE/ALTER` to "self-heal" production (all explicitly forbidden).

Note: LabTrax `/api/healthz` is trivial (no DB) and `index.ts` opens the listener
immediately with all DB work fire-and-forget, so a missing column does NOT crash
boot or fail healthz directly — it 500s the routes that read it (`/lists`,
`/locations` read `lab_locations`). The promote failure that coincides with the
drift is still cleared by re-publishing (applies the column + re-runs promote).
