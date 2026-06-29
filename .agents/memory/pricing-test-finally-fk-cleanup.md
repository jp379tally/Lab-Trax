---
name: pricing.test.ts dedicated-org finally FK cleanup failures
description: Why two api-server pricing tests fail locally on the shared dev DB with a RESTRICT FK error during their own finally cleanup.
---

Two tests in `artifacts/api-server/src/routes/pricing.test.ts` — the
discount parity test and the "re-prices existing draft invoice" test —
create a *dedicated* provider org (random id) + a case referencing it, then
delete that org inside their own `try/finally`. `cases.providerOrganizationId`
is an `onDelete: "restrict"` FK (confirmed in both schema and the live dev DB),
so deleting the org while the case still exists raises
`cases_provider_organization_id_organizations_id_fk`. The suite's `afterAll`
deletes cases-by-labOrgId *before* orgs, but those per-test `finally` blocks
run earlier, so they fail deterministically.

**Why:** these are cleanup-ordering issues local to those tests; they surface
on the persistent shared dev DB (matches the documented "CI passes, local
doesn't" pattern for api-server DB suites). The failures are DELETE-query
errors, not assertion failures — all the test's expects pass.

**How to apply:** if you see only these two tests red with that FK error,
it is not your regression unless you touched their bodies. To actually fix
them, delete the case (and its invoice/events) before deleting the dedicated
provider org in each `finally`.
