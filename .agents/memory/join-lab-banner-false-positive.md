---
name: Join-a-lab banner false positive
description: "Join a lab" banner shows incorrectly on startup because hasActiveLabMembership starts false and the async cache/sync check hasn't resolved yet.
---

## The rule

Never render the "Join a lab" banner on `!userIsAffiliated` alone. Gate it on `labAffiliationReady && !userIsAffiliated`. `labAffiliationReady` must be `false` until either the AsyncStorage cache read or the live API sync has completed.

**Why:** `hasActiveLabMembership` initializes to `false`. The AsyncStorage cache read (`@drivesync_lab_affiliated:<userId>`) is async. If it's slow (or if the cache is cold after reinstall/update), the banner renders and persists until the API sync completes. Users who have an active lab membership see a false "Join a lab" prompt and may sign out/in to dismiss it.

**How to apply:**
- `app-context.tsx`: declare `const [labAffiliationReady, setLabAffiliationReady] = useState(false)`.
- Set `labAffiliationReady(true)` in the AsyncStorage hydration `.then` **and** `.catch` (both directions mean "we know the answer").
- Set `labAffiliationReady(true)` in both branches of `syncActiveLabAffiliationState` (has membership and no membership).
- Export `labAffiliationReady` from the context.
- In every consumer that shows the banner: `{labAffiliationReady && !userIsAffiliated && <Banner />}`.
- In `index.tsx` there are TWO banner locations (TechDashboard line ~682, ProviderDashboard line ~7766) — both need the guard.
