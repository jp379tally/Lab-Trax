---
name: Disabled useQuery still causes test flakiness
description: Even enabled:false useQuery registers an observer that adds mount overhead — use queryClient.getQueryData() for non-reactive cache reads in timing-sensitive components.
---

## Rule

When a component needs data from the React Query cache but must not create a new observer (to avoid interfering with the timing of sibling queries), use `queryClient.getQueryData<T>(key) ?? fallback` instead of `useQuery({ enabled: false })`.

**Why:** Even a disabled `useQuery` call registers a React Query observer on mount. This adds synchronous overhead (internal state initialization, subscription tracking) that can push other queries — particularly a primary `detailQuery` — past `waitFor`'s timeout in slower test environments. The effect is invisible in production but surfaces as intermittent test failures when multiple observers compete.

**How to apply:**
- The consuming component calls `const queryClient = useQueryClient()` (likely already present for invalidations).
- Replace `useQuery({ enabled: someCondition === undefined })` + `useMemo` with a plain `useMemo(() => condition !== undefined ? condition : queryClient.getQueryData<T>(key) ?? [], [condition, queryClient])`.
- The parent page (e.g. `InvoicesPage`) keeps its own always-enabled `useQuery` to populate the cache; the child just reads from it.
- The `getQueryData()` call is not reactive — it reads the cache snapshot at the time of the memo computation. This is fine for autocomplete/dropdown data that updates infrequently.
