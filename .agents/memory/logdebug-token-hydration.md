---
name: logDebugEvent token hydration
description: logDebugEvent read _accessToken synchronously and always got 401 when token wasn't yet in memory; fix and the mobile-cookie-jar corollary.
---

## The rule
`logDebugEvent` must await token hydration before reading `_accessToken`, the same way `resilientFetch` does. Reading it synchronously always produces null (and a 401) when the in-memory token hasn't been loaded yet on a given app launch.

**Why:** In a TestFlight production session, `_accessToken` is null at call time even though the user is authenticated — because `loadTokens()` is async and fires after the app boots, while `logDebugEvent` was synchronous. Result: every `POST /api/debug/event` returned 401 and the entire MOBILE_DEBUG timeline was invisible, masking the real sync failure.

**How to apply:** The fixed `logDebugEvent` wraps its work in an async IIFE, awaits `loadTokens()` (and `refreshAccessToken()` if a refresh token is present), then reads `_accessToken`. If still null after hydration, it skips silently instead of firing an unauthenticated request.

## Corollary: analyze-prescription vs. resilientFetch divergence
`POST /api/analyze-prescription` in scan.tsx uses `expoFetch` with a conditional auth header (`if (token) headers["Authorization"] = ...`). When `_accessToken` is null it sends no bearer header but still succeeds because the server accepts the session cookie auto-attached by RN's fetch jar. This makes the user appear "logged in" while `resilientFetch` for authenticated paths (e.g. `/api/legacy/cases`) will throw "Not authenticated: no bearer token available." — the case is written to AsyncStorage locally but never reaches the server.

## Mobile sync failure surface
When `resilientFetch` throws "Not authenticated", `syncCaseToServer` catches it and returns false. Previously the IIFE silently dropped the case. Fix: in the addCase IIFE, after `!ok`, check `getAccessToken()` — if still null, show `Alert.alert("Case Not Synced — Sign In Required")` so the failure is visible to the user.

## DB query gotcha — lab_memberships column name
The join column in `lab_memberships` is `lab_id`, NOT `organization_id`. Queries using `lm.organization_id` fail silently (empty result) and look like missing rows. Always use `lab_id` when joining to `organizations`.
