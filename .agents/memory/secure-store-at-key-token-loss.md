---
name: SecureStore "@"-key token loss
description: expo-secure-store rejects keys containing "@"; a swallowed SecureStore throw silently loses tokens and presents as a logged-in shell that 401s on every data call.
---

# SecureStore "@"-prefixed key → silent token loss

expo-secure-store (15.x) validates keys: only alphanumeric, `.`, `-`, `_`.
A key containing `@` makes `SecureStore.get/setItemAsync` **throw** `Invalid key`
on native (iOS/Android). It does NOT throw on web (web path uses AsyncStorage,
which accepts any key) and does NOT throw in vitest (SecureStore is mocked and
the mock ignores key validation) — so the bug is invisible to the test suite and
to web/dev, and only surfaces on a real device build.

**Symptom pattern:** the app looks logged in (the user/profile shell renders) but
every authenticated data request returns 401 with no `Authorization` header.

**Why the asymmetry (LabTrax mobile):** two fetch paths behave differently when
the in-memory bearer token is null:
- `resilientFetch` (used by `/api/auth/me` at bootstrap) THROWS
  "Not authenticated: no bearer token available" on a missing token. In
  `auth-context.loadAuth()` that throw is caught and treated as a *network error*
  → keeps the user authenticated offline. So the shell renders.
- the generated `customFetch` (used by `useCases` → `/api/cases`) has NO
  missing-token guard → sends the request unauthenticated → 401 → error UI.

**Root durability bug:** the token store's `secureSetItem` swallowed the
SecureStore throw with no fallback, so tokens never persisted on native and
could not be reloaded on relaunch. In-memory tokens worked only within a single
fresh-login session; every relaunch was tokenless.

**Fix that worked:** use a SecureStore-valid key (drop the `@`), add a one-time
migration that reads the legacy `@`-key value (web only — native never persisted
anything there) and re-writes it under the valid key. Keep tokens
SecureStore-only (no plaintext AsyncStorage fallback, per threat model).
Additionally gate session-restore on token presence
(`getHasUsableToken() = _accessToken || _refreshToken`, native-only) so a
stale logged-in flag without a usable token routes to a clean login instead of
the logged-in-but-401 dead end — this self-heals upgrade-in-place installs.

**Residual (not fixed in that change):** `auth-context.tsx` also has `@`-prefixed
sensitive keys (`@drivesync_auth_password`, `@drivesync_biometric_user`). Their
`setSensitiveItem` DOES have an AsyncStorage fallback, so they "work" — but that
means the raw password lands in **plaintext AsyncStorage** on native instead of
SecureStore. Rename those keys (same migration pattern) to restore encrypted
storage.

**How to apply:** never use `@` (or any non `[A-Za-z0-9._-]`) in a SecureStore
key. When a SecureStore write can fail, fail loud or have an explicit, intended
fallback — never silently swallow, or you lose the token with no signal. Web/dev
and vitest will not catch this; reason about the native path explicitly.
