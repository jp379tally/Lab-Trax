---
name: Dev smoke of platform-admin endpoints
description: PLATFORM_ADMIN_SECRET is prod-only; how to exercise admin endpoints in dev
---

PLATFORM_ADMIN_SECRET is a production-only deployment secret — it is NOT in the dev workspace env (only PLATFORM_ADMIN_PIN is), so the dev API Server workflow returns 401/403 on all /api/admin/* secret-header calls.

**Why:** admin endpoints require the secret header; without it dev smoke tests of admin routes silently look "broken".

**How to apply:** to smoke an admin endpoint in dev, boot a short-lived server inside ONE bash call with an ad-hoc secret, curl it, then kill it:
`cd artifacts/api-server && (PLATFORM_ADMIN_SECRET=dev-smoke PORT=8099 npx tsx src/index.ts & echo $! > /tmp/pid); poll healthz; curl -H 'X-Platform-Admin-Secret: dev-smoke' ...; kill $(cat /tmp/pid)`
(Backgrounded processes die when the tool call returns, so the whole cycle must stay in one call.) Live/destructive admin runs against real data happen only via the published prod endpoint with the prod secret.
