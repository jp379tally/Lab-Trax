---
name: Desktop apiFetch unwraps the { ok, data } envelope
description: Why desktop callers must read r.X not r.data.X, and how a whole panel silently broke
---

The API wraps every success response as `{ ok: true, data: {...} }` (see
`ok()` in `artifacts/api-server/src/lib/http.ts`). The desktop client's
`apiFetch` (`artifacts/labtrax-desktop/src/lib/api.ts`) automatically
**unwraps** `.data` when the parsed body is an object that has a `data`
key and few top-level keys. So callers must read `r.fieldName`, NOT
`r.data.fieldName`.

**Why this matters:** a caller that reads `r.data.X` gets `undefined.X`
silently — no error, the value is just `undefined`. An entire 2FA settings
panel (status/setup/confirm/backup-codes readers) was written with the
`r.data.X` pattern, so 2FA status always read `undefined` → the panel's
gated sub-sections (backup codes, trusted devices) never rendered. It
looked like "no UI was ever built" when the UI existed but was dead.

**How to apply:** when adding desktop `apiFetch` callers, type the generic
as the inner shape (`apiFetch<{ twoFactorEnabled: boolean }>`) and read
fields directly. The mobile client's `apiCall` does the same unwrap
(`json?.data ?? json`). If a desktop feature "exists in code but never
shows up", check whether its gate is reading `r.data.X` against an
already-unwrapped response.
