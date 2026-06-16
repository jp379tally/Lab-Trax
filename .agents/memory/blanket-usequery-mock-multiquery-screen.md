---
name: blanket useQuery mock breaks multi-query screens
description: vi.mocked(useQuery).mockReturnValue(X) feeds the same shape to every useQuery on a screen, crashing siblings.
---

A mobile/web screen often calls `useQuery` several times (e.g. mobile
`app/settings/organizations.tsx`: meQuery, clusterQuery, invitesQuery). A test
that stubs `vi.mocked(useQuery).mockReturnValue(meShape)` feeds that **one**
shape to **every** consumer. `PendingInvitesCard` does `invites = data ?? []`
then `invites.map(...)` → `TypeError: invites.map is not a function`, failing
the whole render (and every test in the file) even though the test only cares
about the me-query.

**Fix:** mock by query key with `mockImplementation((opts) => …)`, switching on
`opts.queryKey[0]` so list queries return arrays and the me-query returns the
shape under test. See `organizations.smoke.test.tsx` `applyUseQueryMock`.

**Why to remember:** adding a new `useQuery` to a screen can silently break
unrelated smoke tests that used a blanket `mockReturnValue`. When a screen-level
smoke test fails with `.map is not a function` / `.filter is not a function`
after an unrelated change, suspect the blanket mock before the component.
