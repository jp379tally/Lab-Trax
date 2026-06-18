/**
 * CSRF tests — two complementary suites:
 *
 * 1. Unit suite (always-on): calls requireCsrf() directly with lightweight mock
 *    req/res/next objects.  Validates every branch of the middleware logic.
 *
 * 2. HTTP integration suite (always-on): mounts requireCsrf inside a real,
 *    minimal Express app via supertest and asserts actual HTTP response codes.
 *    This proves the middleware is correctly wired and would catch regressions
 *    such as CSRF being removed from the middleware chain, reordered, or its
 *    error-handler arguments changed.  No DATABASE_URL required — the minimal
 *    app never touches the database.
 *
 * Coverage (shared across both suites):
 *  - GET / HEAD / OPTIONS are never blocked (safe methods)
 *  - Cookie-authenticated POST/PUT/PATCH/DELETE without CSRF header → 403
 *  - Cookie-authenticated POST with a matching CSRF token → allowed (passes middleware)
 *  - Cookie-authenticated POST with a mismatched CSRF token → 403
 *  - Bearer-authenticated POST without CSRF header → allowed (bearer exempt)
 *  - Cookie-authenticated POST without browser signals → allowed (native client)
 *  - Exempt auth paths (/auth/login etc.) → always allowed
 *  - No auth cookie present → allowed (auth check deferred to requireAuth)
 */

import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { requireCsrf } from "./csrf.js";
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
} from "../lib/cookies.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CookieMap = Record<string, string>;

interface MockRequestOptions {
  method?: string;
  path?: string;
  cookies?: CookieMap;
  headers?: Record<string, string>;
}

function makeReq(opts: MockRequestOptions = {}): Request {
  const {
    method = "POST",
    path = "/cases",
    cookies = {},
    headers = {},
  } = opts;

  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lowerHeaders[k.toLowerCase()] = v;
  }

  const req = {
    method,
    path,
    cookies,
    get(name: string): string | undefined {
      return lowerHeaders[name.toLowerCase()];
    },
    headers: lowerHeaders,
  } as unknown as Request;

  return req;
}

function makeNext(): NextFunction & { calls: unknown[][] } {
  const fn = vi.fn() as unknown as NextFunction & { calls: unknown[][] };
  fn.calls = (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return fn;
}

const mockRes = {} as Response;

// Cookie sets that produce an "auth cookie present" request
const withAccessCookie: CookieMap = { [ACCESS_COOKIE_NAME]: "token-value" };
const withRefreshCookie: CookieMap = { [REFRESH_COOKIE_NAME]: "refresh-value" };

// A valid CSRF pair: cookie value matches header value
const CSRF_VALUE = "abc123valid";
const validCsrfCookies: CookieMap = {
  [ACCESS_COOKIE_NAME]: "token-value",
  [CSRF_COOKIE_NAME]: CSRF_VALUE,
};

// Browser origin/referer/sec-fetch-site signals
const browserOriginHeaders = { origin: "https://labtrax.example.com" };
const browserRefererHeaders = { referer: "https://labtrax.example.com/cases" };
const browserSecFetchHeaders = { "sec-fetch-site": "same-origin" };

// ---------------------------------------------------------------------------
// Safe methods — GET / HEAD / OPTIONS
// ---------------------------------------------------------------------------

describe("requireCsrf — safe methods", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    it(`allows ${method} with auth cookie and browser signals and no CSRF header`, () => {
      const next = makeNext();
      const req = makeReq({
        method,
        cookies: withAccessCookie,
        headers: browserOriginHeaders,
      });
      requireCsrf(req, mockRes, next);
      expect(next).toHaveBeenCalledOnce();
      expect(next.calls[0]).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Exempt auth paths
// ---------------------------------------------------------------------------

describe("requireCsrf — exempt auth paths", () => {
  for (const path of [
    "/auth/login",
    "/auth/register",
    "/auth/refresh",
    "/auth/logout",
  ]) {
    it(`allows POST ${path} even with auth cookie and browser signals`, () => {
      const next = makeNext();
      const req = makeReq({
        method: "POST",
        path,
        cookies: withAccessCookie,
        headers: browserOriginHeaders,
      });
      requireCsrf(req, mockRes, next);
      expect(next).toHaveBeenCalledOnce();
      expect(next.calls[0]).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Bearer-token requests — CSRF does not apply
// ---------------------------------------------------------------------------

describe("requireCsrf — bearer-authenticated requests", () => {
  it("allows POST with Authorization: Bearer even if auth cookie is present and browser signals set", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      cookies: withAccessCookie,
      headers: {
        authorization: "Bearer some.jwt.token",
        origin: "https://labtrax.example.com",
      },
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });

  it("allows PUT with Bearer and no CSRF header", () => {
    const next = makeNext();
    const req = makeReq({
      method: "PUT",
      headers: { authorization: "Bearer jwt.token.here" },
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });

  it("allows DELETE with Bearer and no CSRF header", () => {
    const next = makeNext();
    const req = makeReq({
      method: "DELETE",
      headers: { authorization: "Bearer jwt.token.here" },
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No auth cookie — deferred to requireAuth
// ---------------------------------------------------------------------------

describe("requireCsrf — no auth cookie present", () => {
  it("allows POST with no cookies at all (no auth, no CSRF)", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      cookies: {},
      headers: browserOriginHeaders,
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cookie-authenticated — matching CSRF token → allowed
// ---------------------------------------------------------------------------

describe("requireCsrf — valid CSRF double-submit token", () => {
  it("allows POST when CSRF cookie matches CSRF header", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      cookies: validCsrfCookies,
      headers: {
        [CSRF_HEADER_NAME]: CSRF_VALUE,
        origin: "https://labtrax.example.com",
      },
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });

  it("allows PUT when CSRF cookie matches CSRF header", () => {
    const next = makeNext();
    const req = makeReq({
      method: "PUT",
      cookies: validCsrfCookies,
      headers: { [CSRF_HEADER_NAME]: CSRF_VALUE, origin: "https://lab.example" },
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });

  it("allows PATCH when CSRF cookie matches CSRF header", () => {
    const next = makeNext();
    const req = makeReq({
      method: "PATCH",
      cookies: validCsrfCookies,
      headers: { [CSRF_HEADER_NAME]: CSRF_VALUE, referer: "https://lab.example" },
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });

  it("allows DELETE when CSRF cookie matches CSRF header", () => {
    const next = makeNext();
    const req = makeReq({
      method: "DELETE",
      cookies: validCsrfCookies,
      headers: { [CSRF_HEADER_NAME]: CSRF_VALUE, origin: "https://lab.example" },
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cookie-authenticated — missing or wrong CSRF token + browser signals → 403
// ---------------------------------------------------------------------------

describe("requireCsrf — cookie-authenticated with browser signals, no valid CSRF token → 403", () => {
  it("blocks POST with no CSRF header when Origin is present", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      cookies: withAccessCookie,
      headers: browserOriginHeaders,
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    const [err] = next.calls[0] as [unknown];
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("blocks POST with no CSRF header when Referer is present", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      cookies: withAccessCookie,
      headers: browserRefererHeaders,
    });
    requireCsrf(req, mockRes, next);
    const [err] = next.calls[0] as [unknown];
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("blocks POST with no CSRF header when Sec-Fetch-Site is present", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      cookies: withAccessCookie,
      headers: browserSecFetchHeaders,
    });
    requireCsrf(req, mockRes, next);
    const [err] = next.calls[0] as [unknown];
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("blocks PUT with no CSRF header when Origin is present", () => {
    const next = makeNext();
    const req = makeReq({
      method: "PUT",
      cookies: withAccessCookie,
      headers: browserOriginHeaders,
    });
    requireCsrf(req, mockRes, next);
    const [err] = next.calls[0] as [unknown];
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("blocks PATCH with no CSRF header when Origin is present", () => {
    const next = makeNext();
    const req = makeReq({
      method: "PATCH",
      cookies: withAccessCookie,
      headers: browserOriginHeaders,
    });
    requireCsrf(req, mockRes, next);
    const [err] = next.calls[0] as [unknown];
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("blocks DELETE with no CSRF header when Origin is present", () => {
    const next = makeNext();
    const req = makeReq({
      method: "DELETE",
      cookies: withAccessCookie,
      headers: browserOriginHeaders,
    });
    requireCsrf(req, mockRes, next);
    const [err] = next.calls[0] as [unknown];
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("blocks POST when CSRF cookie is absent but header is present (forged header)", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      // auth cookie set, but no CSRF cookie
      cookies: { [ACCESS_COOKIE_NAME]: "token-value" },
      headers: {
        [CSRF_HEADER_NAME]: "some-value",
        origin: "https://labtrax.example.com",
      },
    });
    requireCsrf(req, mockRes, next);
    const [err] = next.calls[0] as [unknown];
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("blocks POST when CSRF header value does not match the cookie value", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      cookies: validCsrfCookies,
      headers: {
        [CSRF_HEADER_NAME]: "wrong-value",
        origin: "https://labtrax.example.com",
      },
    });
    requireCsrf(req, mockRes, next);
    const [err] = next.calls[0] as [unknown];
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("blocks POST with refresh cookie (not access cookie) + browser signal + no CSRF", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      cookies: withRefreshCookie,
      headers: browserOriginHeaders,
    });
    requireCsrf(req, mockRes, next);
    const [err] = next.calls[0] as [unknown];
    expect(err).toMatchObject({ statusCode: 403 });
  });
});

// ---------------------------------------------------------------------------
// Cookie-authenticated — no browser signals → allowed (native client path)
// ---------------------------------------------------------------------------

describe("requireCsrf — cookie-authenticated without browser signals → allowed (native / curl)", () => {
  it("allows POST with auth cookie but no Origin, Referer, or Sec-Fetch-Site", () => {
    const next = makeNext();
    const req = makeReq({
      method: "POST",
      cookies: withAccessCookie,
      // No browser-signal headers at all
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });

  it("allows PUT with auth cookie and no browser signals", () => {
    const next = makeNext();
    const req = makeReq({
      method: "PUT",
      cookies: withAccessCookie,
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });

  it("allows DELETE with auth cookie and no browser signals", () => {
    const next = makeNext();
    const req = makeReq({
      method: "DELETE",
      cookies: withAccessCookie,
    });
    requireCsrf(req, mockRes, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.calls[0]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration suite — requireCsrf mounted in a real Express app
//
// These tests use supertest to fire actual HTTP requests and assert real status
// codes.  The app is minimal (no database, no auth): routes behind /api simply
// return 200 OK so that any 403 response is unambiguously from CSRF.  This
// suite would fail if:
//   • requireCsrf were removed from the middleware chain
//   • requireCsrf were moved AFTER route handlers
//   • the middleware's error argument were changed (breaking Express error-handling)
//   • the 4-argument error handler were dropped from the test app
// ---------------------------------------------------------------------------

function buildTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  // Mount requireCsrf the same way app.ts does: before all /api/* routes.
  app.use(
    "/api",
    requireCsrf,
    (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    },
  );

  // 4-argument Express error handler — required for HttpError thrown by CSRF.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = (err as Error).message ?? "Server error";
    res.status(status).json({ ok: false, message });
  });

  return app;
}

const httpApp = buildTestApp();

// Helper: build a Cookie header string from a map of name→value pairs.
function cookieHeader(cookies: CookieMap): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

describe("requireCsrf — HTTP integration (real Express + supertest)", () => {
  // ── Blocking: cookie + browser signal + no CSRF token ──────────────────

  it("returns 403 for POST with auth cookie, Origin header, and no CSRF token", async () => {
    const res = await request(httpApp)
      .post("/api/anything")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(403);
  });

  it("returns 403 for POST with auth cookie, Referer header, and no CSRF token", async () => {
    const res = await request(httpApp)
      .post("/api/cases")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Referer", "https://labtrax.example.com/cases");
    expect(res.status).toBe(403);
  });

  it("returns 403 for POST with auth cookie, Sec-Fetch-Site header, and no CSRF token", async () => {
    const res = await request(httpApp)
      .post("/api/cases")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Sec-Fetch-Site", "same-origin");
    expect(res.status).toBe(403);
  });

  it("returns 403 for PUT with auth cookie + Origin and no CSRF token", async () => {
    const res = await request(httpApp)
      .put("/api/cases/1")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(403);
  });

  it("returns 403 for PATCH with auth cookie + Origin and no CSRF token", async () => {
    const res = await request(httpApp)
      .patch("/api/cases/1")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(403);
  });

  it("returns 403 for DELETE with auth cookie + Origin and no CSRF token", async () => {
    const res = await request(httpApp)
      .delete("/api/cases/1")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(403);
  });

  it("returns 403 when CSRF header value does not match the cookie value", async () => {
    const res = await request(httpApp)
      .post("/api/cases")
      .set("Cookie", cookieHeader(validCsrfCookies))
      .set("Origin", "https://labtrax.example.com")
      .set(CSRF_HEADER_NAME, "wrong-value-entirely");
    expect(res.status).toBe(403);
  });

  // ── Passing: cookie + browser signal + valid double-submit CSRF token ───

  it("returns 200 for POST when CSRF cookie matches CSRF header (valid double-submit)", async () => {
    const res = await request(httpApp)
      .post("/api/cases")
      .set("Cookie", cookieHeader(validCsrfCookies))
      .set("Origin", "https://labtrax.example.com")
      .set(CSRF_HEADER_NAME, CSRF_VALUE);
    expect(res.status).toBe(200);
  });

  it("returns 200 for PUT when CSRF cookie matches CSRF header", async () => {
    const res = await request(httpApp)
      .put("/api/cases/1")
      .set("Cookie", cookieHeader(validCsrfCookies))
      .set("Origin", "https://labtrax.example.com")
      .set(CSRF_HEADER_NAME, CSRF_VALUE);
    expect(res.status).toBe(200);
  });

  it("returns 200 for PATCH when CSRF cookie matches CSRF header", async () => {
    const res = await request(httpApp)
      .patch("/api/cases/1")
      .set("Cookie", cookieHeader(validCsrfCookies))
      .set("Referer", "https://labtrax.example.com")
      .set(CSRF_HEADER_NAME, CSRF_VALUE);
    expect(res.status).toBe(200);
  });

  it("returns 200 for DELETE when CSRF cookie matches CSRF header", async () => {
    const res = await request(httpApp)
      .delete("/api/cases/1")
      .set("Cookie", cookieHeader(validCsrfCookies))
      .set("Origin", "https://labtrax.example.com")
      .set(CSRF_HEADER_NAME, CSRF_VALUE);
    expect(res.status).toBe(200);
  });

  // ── Bearer — CSRF does not apply ────────────────────────────────────────

  it("returns 200 for POST with Bearer token even with Origin and no CSRF token", async () => {
    const res = await request(httpApp)
      .post("/api/cases")
      .set("Authorization", "Bearer some.jwt.token")
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(200);
  });

  it("returns 200 for DELETE with Bearer token and no CSRF token", async () => {
    const res = await request(httpApp)
      .delete("/api/cases/1")
      .set("Authorization", "Bearer some.jwt.token")
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(200);
  });

  // ── Safe methods — never blocked ────────────────────────────────────────

  it("returns 200 for GET with auth cookie, Origin, and no CSRF token", async () => {
    const res = await request(httpApp)
      .get("/api/cases")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(200);
  });

  it("returns 200 for HEAD with auth cookie, Origin, and no CSRF token", async () => {
    const res = await request(httpApp)
      .head("/api/cases")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(200);
  });

  // ── Exempt auth paths ───────────────────────────────────────────────────

  it("returns 200 for POST /api/auth/login with auth cookie + Origin and no CSRF", async () => {
    const res = await request(httpApp)
      .post("/api/auth/login")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(200);
  });

  it("returns 200 for POST /api/auth/register with auth cookie + Origin and no CSRF", async () => {
    const res = await request(httpApp)
      .post("/api/auth/register")
      .set("Cookie", cookieHeader(withAccessCookie))
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(200);
  });

  // ── Native client — no browser signals ──────────────────────────────────

  it("returns 200 for POST with auth cookie but no Origin/Referer/Sec-Fetch-Site", async () => {
    const res = await request(httpApp)
      .post("/api/cases")
      .set("Cookie", cookieHeader(withAccessCookie));
    expect(res.status).toBe(200);
  });

  // ── No auth cookie — deferred to requireAuth ─────────────────────────────

  it("returns 200 for POST with no cookies at all (CSRF deferred to auth middleware)", async () => {
    const res = await request(httpApp)
      .post("/api/cases")
      .set("Origin", "https://labtrax.example.com");
    expect(res.status).toBe(200);
  });
});
