---
name: UnassignedDocumentsCard preview test flake
description: rel-desktop-tests gate flakes on the UnassignedDocumentsCard preview timeout; passes in isolation.
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
before assuming your change broke it. A follow-up task exists to deflake it
properly (waitFor-wrap trailing assertions / raise its per-test timeout).
