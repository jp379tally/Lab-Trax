---
name: api-server vitest hermeticity traps
description: Two environment/contract traps that make api-server vitest suites fail in ways that look like code bugs but aren't.
---

# api-server vitest hermeticity traps

## 1. LABTRAX_ENABLE_DEMO_SEEDS leaks into the test run
`registerRoutes()` calls `seedDefaultUsers()` at app-init, gated by
`process.env.LABTRAX_ENABLE_DEMO_SEEDS === "true"`. The Replit workspace sets
that flag to `"true"`. In **mocked-db** suites (e.g. admin-subscriptions,
analyze-prescription) the partial db mock has no chainable `db.insert().values()`,
so init throws `db.insert(...).values is not a function`, the LabTrax router
never mounts, and every route in that suite 404s → whole file fails.

**Symptom:** a mocked-db suite fails *en masse* with unrelated-looking status
mismatches; log shows `Failed to initialise LabTrax routes: ... .values is not a function`.

**Fix:** `vitest.config.ts` sets `test.env = { LABTRAX_ENABLE_DEMO_SEEDS: "false" }`
so the suite is hermetic regardless of host env. Test authors already assumed the
flag is off.

## 2. createRateLimit throttles cross-file in a shared fork
`lib/rate-limit.ts` keys on `path:ip` in a module-level Map. supertest always hits
from one loopback IP, and vitest `pool:forks` shares that Map across all test files
in a fork. Register is 5/60s — a single suite doing >5 endpoint registers, or two
auth suites colliding in one fork, yields order-dependent 429s.

**Fix:** `createRateLimit` no-ops when `process.env.VITEST` is set (no test asserts
429 on these limiters; rate limiting is a production-only safeguard).

**Why it matters:** before adding any new suite that registers/logs in via the HTTP
endpoint, remember the limiter is now disabled under vitest — don't reintroduce a
per-test X-Forwarded-For workaround.
