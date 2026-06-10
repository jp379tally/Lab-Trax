---
name: React Query mobile auth refresh wiring
description: How to wire customFetch for 401-retry + SecureStore hydration on mobile, and how to mock React Query hooks in smoke tests.
---

## Rules

**customFetch 401-retry:** Add `setAuthRefresher(fn)` to `lib/api-client-react/src/custom-fetch.ts`. On 401, call the refresher, update the Authorization header, and retry once. Without this, canonical hooks go dead after token expiry.

**Token getter hydration:** The `setAuthTokenGetter` call in `query-client.ts` must be async and hydrate from SecureStore when `_accessToken` is null — mirrors the same guard in `resilientFetch`. A synchronous `() => _accessToken` getter misses cold-start and resume cases.

**Smoke test mocking:** Screens that use `useCases`/`useCase`/`useInvoices`/`useInvoice` from `@workspace/api-client-react` require a `vi.mock("@workspace/api-client-react", ...)` in `vitest.setup.ts` that bypasses React Query entirely. Without it, tests throw "No QueryClient set". The mock should read from `mockAppOverrides.current` so `setMockAppState` still drives test data.

**expo-file-system/legacy mock:** Add a separate `vi.mock("expo-file-system/legacy", ...)` stub — the existing `expo-file-system` mock does not cover the `/legacy` subpath.

**Why:** React Query hooks require a QueryClientProvider at render time. Smoke tests render bare components without a provider, so any hook that calls `useQueryClient()` throws at render.
