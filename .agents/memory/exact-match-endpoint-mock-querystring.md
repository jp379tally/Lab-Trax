---
name: Exact-match endpoint mocks break when a fetch URL gains a query string
description: Why adding ?param=... to a production apiFetch URL silently breaks test mocks that match the endpoint by string equality
---

When a desktop/web component starts fetching an endpoint with a query string
(e.g. `apiFetch("/organizations?includeLabPractices=true")` instead of
`apiFetch("/organizations")`), any test that mocks `apiFetch` with an
**exact-equality** matcher (`if (endpoint === "/organizations") return [];`)
stops matching. The call then falls through to the mock's default return. If
that default is a non-array truthy value (commonly `return {}`), the component
crashes at render time on `(query.data ?? []).filter(...)` — `?? []` does NOT
save you because `{}` is not nullish.

**Why:** the symptom is misleading. The crash surfaces in whatever test renders
the page (e.g. a deep-link / notification-navigation test asserting `/cases/abc`
was fetched), not in an "organizations" test — the uncaught TypeError aborts the
render before the asserted fetch ever fires, so the failure reads like a routing
bug. Note two mock layers behave differently: tests that mock global `fetch`
returning `{}` are saved because `apiFetch` unwraps `{ok,data}` → `undefined`;
tests that mock `apiFetch` **directly** return `{}` verbatim → crash.

**How to apply:** when you change a production fetch URL to add/alter a query
string, grep tests for exact `endpoint === "/<path>"` / `=== "/<path>"` matchers
and switch them to `.startsWith("/<path>")` (or `.includes`). This repo has many
exact-match `/organizations` mocks. The full pre-release desktop test suite
(`pnpm --filter @workspace/labtrax-desktop run test`) is what catches this;
post-merge setup does not run it, so a merged URL change can ship a green
typecheck but a red protected test.
