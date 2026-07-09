---
name: Express catch-all shadows later literal routes
description: In big routers (e.g. invoices.ts), GET /:param registered before a literal single-segment route makes the literal route unreachable (404).
---

# Express catch-all shadows later literal routes

Express matches routes in registration order. In a large router where `GET /:invoiceId`-style
catch-alls exist, any single-segment literal route (e.g. `GET /practice-statements`) registered
AFTER the catch-all is unreachable: the catch-all consumes the path segment as a param and the
handler 404s ("invoice not found").

**Why:** `GET /practice-statements` in the invoices router silently 404'd in real use because it
was registered ~1200 lines after `GET /:invoiceId`. Unit tests that mock fetch never catch this —
only DB-integration tests hitting the real router do.

**How to apply:**
- When adding a literal route to a router that has `/:param` catch-alls, register it ABOVE the
  catch-all (segment-count matters: only same-segment-count literals collide).
- When a new endpoint mysteriously 404s despite correct code, check registration order vs
  catch-alls before debugging the handler.
- Prefer an integration test that hits the real router (supertest) so shadowing is caught.
