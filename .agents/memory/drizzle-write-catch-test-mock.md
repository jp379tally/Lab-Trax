---
name: Drizzle write .catch breaks then-only test mocks
description: Why fully-mocked @workspace/db tests 500 when a route chains .catch/.finally onto a Drizzle write.
---

Real Drizzle query builders (QueryPromise) implement the full promise
interface — `then`, `catch`, AND `finally`. Route handlers exploit this by
chaining `.catch(wrapDbError)` (and sometimes `.finally`) directly onto
`db.insert(...).values(...)` / `db.update(...).set(...).where(...)` to turn
raw DB errors into safe HttpErrors.

**The trap:** Tests that hoist `vi.mock("@workspace/db")` and hand-roll a
query-builder chain often implement only `then` (a bare thenable). `await
chain` works, but `chain.catch(...)` is `undefined` → TypeError → caught by
asyncHandler → HTTP 500. The failure looks like an auth/business-logic bug
but is purely a stale mock; the real DB path is fine.

**Why:** A db-error-hardening pass (convention: every route insert/update
gets `.catch(wrapDbError)`) can land without touching these fully-mocked
test files, so the mock silently lags the production contract. This is what
turned a green api-server gate red right before an iOS pre-build run.

**How to apply:**
- When mocking `@workspace/db` query builders, model insert/update/select
  chains as FULL promise-likes: `then` + `catch` + `finally`, all delegating
  to one resolved promise (`const settled = Promise.resolve(); then/catch/
  finally → settled.*`). Never ship a then-only thenable.
- When you add/remove `.catch`/`.finally` on a route's db call, grep for
  fully-mocked tests of that route and update their chain mocks in lockstep.
- Symptom signature: a deterministic 500 in a fully-mocked route test
  immediately after a "protect db errors / wrapDbError" change.
- Note: in `auth-desktop.test.ts` the update chain is safe only because its
  `where()` returns a real `Promise`; the select chain is still then-only and
  would hit the same trap if a route chains `.catch` onto a select.
