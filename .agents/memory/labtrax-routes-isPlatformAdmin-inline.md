---
name: labtrax-routes isPlatformAdmin inline definition
description: isPlatformAdmin is defined inline in labtrax-routes.ts, not imported from auth middleware; test mocks that override auth.js do NOT affect it.
---

# isPlatformAdmin is defined inline in labtrax-routes.ts

## The rule

`isPlatformAdmin(req)` is a **module-private function** at line ~225 of
`artifacts/api-server/src/routes/labtrax-routes.ts`. It is NOT exported from
`./middlewares/auth.js`. Mocking `./middlewares/auth.js` in tests does **not**
affect the `isPlatformAdmin` calls inside the labtrax router.

## How the function works (at call time)

```typescript
function isPlatformAdmin(req: any): boolean {
  if (req._platformAdminSessionVerified) return req.user?.role === "admin";
  const reqUser = req.user;
  if (!reqUser || reqUser.role !== "admin") return false;  // ← blocks here when req.user is absent
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  if (secret && req.headers["x-platform-admin-secret"] === secret) return true;
  const effectivePin = getEffectiveAdminPin();
  if (req.headers["x-platform-admin-pin"] === effectivePin) return true;
  return false;
}
```

The `X-Platform-Admin-Secret` header check is only reached **after** the
`req.user.role === "admin"` guard passes.

## How to apply in tests

When mocking `./middlewares/auth.js` to bypass JWT verification, the
`requireAuth` mock **must** set a synthetic admin user on `req` or every
`isPlatformAdmin` call will return false (403):

```typescript
vi.mock("./middlewares/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "test-admin-id", role: "admin", organizationId: null };
    next();
  },
  // ...
}));
```

Then set `process.env.PLATFORM_ADMIN_SECRET` and send
`X-Platform-Admin-Secret: <secret>` in the request — that is what the inline
function validates after the user guard passes.

**Why:** `isPlatformAdmin` was defined inline so it can read the in-memory PIN
cache via `getEffectiveAdminPin()` (a module-private helper) without exposing
that helper in the public auth API.
