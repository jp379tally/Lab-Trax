---
name: rel-desktop-tests full-suite flakes
description: rel-desktop-tests gate flakes on several jsdom tests under the full 2-worker suite; each passes in isolation.
---

The `rel-desktop-tests` release gate intermittently fails on
`artifacts/labtrax-desktop/src/components/__tests__/UnassignedDocumentsCard.preview.test.tsx`
("fetches the file via the authenticated media API and opens a preview window")
with a 5s test timeout under the full suite, alongside a jsdom
"Not implemented: navigation to another Document" warning.

**Why:** the same file passes 6/6 when run in isolation (verified 2026-07-09),
so a red gate on this test alone is a load/timing flake, not a regression.

**How to apply:** if `rel-desktop-tests` is red only on this test, re-run the
file in isolation (`npx vitest run src/components/__tests__/UnassignedDocumentsCard.preview.test.tsx`)
before assuming your change broke it.

**Fixed 2026-07-09:** the file now sets `vi.setConfig({ testTimeout: 30_000,
hookTimeout: 30_000 })` and uses a local `waitFor` wrapper + explicit
`findByRole` timeout of 15s, so slow full-suite scheduling can no longer trip
the default 5s/1s budgets. Pattern to reuse for any other jsdom desktop test
that passes in isolation but times out under the 2-worker full suite: raise
the file's test timeout and pass explicit long timeouts to findBy/waitFor —
real regressions still fail fast on the assertion, only starvation gets the
extra budget. The "Not implemented: navigation to another Document" jsdom
warning is harmless noise from another file, not this test.

**Other known full-suite-only flakes (verified 2026-07-09, both pass in
isolation on the same commit that failed the gate):**
- `src/pages/__tests__/merge-dialog-notification-path.test.tsx` — "opens with
  one target + one selectable source" fails to find the /Review/i button.
- `src/pages/__tests__/settings-profile-phone.test.tsx` — "shows the OTP panel
  after a successful send" hits the 5s timeout.
Re-run these files in isolation before blaming an unrelated change.
