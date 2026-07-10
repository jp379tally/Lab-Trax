---
name: Mobile useQuery stub is per-key and omits isSuccess
description: Why a screen gate that reads doctorResolveQuery.isSuccess silently no-ops in labtrax mobile vitest, and the FormSheet testID collision under the Modal stub.
---

# Mobile `useQuery` stub only serves specific queryKeys

`artifacts/labtrax/vitest.setup.ts` globally `vi.mock`s `@tanstack/react-query`
so `useQuery` returns a hand-rolled object driven by `mockAppOverrides`. It only
populates `data` for keys it explicitly handles (`auth-me`, `statement-runs`,
`doctor-resolve`, …) and by default returns **no `isSuccess` field**.

**Consequence:** a component gate that reads `query.isSuccess && query.data`
(e.g. the AI-reader "doctor not on file" resolution gate in
`app/ai-reader/extracted.tsx`) will silently do nothing in tests even though the
test installs a `setMockFetchHandler` for the endpoint — the real `queryFn`/fetch
never runs because `useQuery` is stubbed.

**How to apply:** to test such a gate, extend the stub's `if (key === "...")`
chain to serve that queryKey from a `mockAppOverrides` field, and add
`isSuccess` to the returned object (scope it to the key to avoid flipping other
screens). Then drive the test via `setMockAppState({ <field>: {...} })`, not via
the fetch handler.

**Why:** the fetch handler only matters for code paths that call `resilientFetch`
directly; anything behind a mocked `useQuery` bypasses it entirely.

# Two FormSheets collide on `form-save` under the RN Modal stub

The mobile test `Modal` stub renders children regardless of `visible`, so every
`<FormSheet>` on a screen mounts at once. `FormSheet` previously hard-coded
`testID="form-save"`/`"form-cancel"`, so a screen with two sheets (AI-reader
confirm sheet + resolve sheet) produced duplicate testIDs → `getByTestId` throws
"multiple elements". Fix: `FormSheet` takes an optional `testIDPrefix`
(default `"form"`); give the second sheet a distinct prefix
(e.g. `testIDPrefix="doctor-resolve"` → `doctor-resolve-save`).

**Why:** same root cause as the general "RN Modal stub renders children" note —
`visible` gating is a no-op in tests, so testID uniqueness must not depend on
only one sheet being open.
