/**
 * Unit tests for the `createCheckEmailThrottle` dual-key rate limiter.
 *
 * The middleware is disabled under VITEST to avoid order-dependent throttling
 * across the broader test suite.  This file exercises it directly by
 * temporarily removing the VITEST env var in beforeEach / afterEach and
 * mounting the middleware on a minimal Express app — no database required.
 *
 * Coverage:
 *  - Per-email limit: the (maxPerEmail+1)th request for the same email → 429
 *  - Per-IP limit fires independently of the per-email limit
 *  - Different email addresses have independent per-email budgets
 *  - Different email addresses share the per-IP budget
 *  - Request with no email query param falls through (throttle skips it)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createCheckEmailThrottle } from "./rate-limit.js";

/**
 * Build a minimal Express app that applies `createCheckEmailThrottle` and
 * returns 200 { ok: true } when the throttle passes the request through.
 *
 * Each test calls this to get a fresh throttle instance.  Because the
 * underlying store is module-level, tests must use distinct email addresses
 * and X-Forwarded-For IPs to avoid cross-test bleed.
 */
function buildApp(opts: {
  windowMs: number;
  maxPerEmail: number;
  maxPerIp: number;
}) {
  const app = express();
  const throttle = createCheckEmailThrottle(opts);
  app.get("/check-email", throttle, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("createCheckEmailThrottle", () => {
  let savedVitest: string | undefined;

  beforeEach(() => {
    // The middleware is a no-op when VITEST is set.  Remove it so these unit
    // tests can observe the real throttle behaviour.
    savedVitest = process.env["VITEST"];
    delete process.env["VITEST"];
  });

  afterEach(() => {
    // Restore so subsequent Vitest infrastructure is unaffected.
    if (savedVitest !== undefined) {
      process.env["VITEST"] = savedVitest;
    }
  });

  it("allows up to maxPerEmail requests and returns 429 on the next one for the same email", async () => {
    // maxPerEmail=5 matches the production limit; use a unique email so this
    // test's counts don't bleed into others sharing the module-level store.
    const app = buildApp({ windowMs: 60_000, maxPerEmail: 5, maxPerIp: 100 });
    const email = "per-email-limit-test@throttle.example";

    for (let i = 0; i < 5; i++) {
      const r = await request(app).get(
        `/check-email?email=${encodeURIComponent(email)}`,
      );
      expect(r.status).toBe(200);
    }

    // Sixth request for the same email must be rejected.
    const r = await request(app).get(
      `/check-email?email=${encodeURIComponent(email)}`,
    );
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/too many email checks for this address/i);
  });

  it("per-IP limit fires independently of the per-email limit", async () => {
    // maxPerEmail is set high so it never triggers; only the per-IP limit
    // (maxPerIp=5) should fire.  Each request uses a different email so the
    // per-email budget is never exhausted for any single address.
    const app = buildApp({ windowMs: 60_000, maxPerEmail: 100, maxPerIp: 5 });
    const ip = "10.0.1.1";

    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .get(`/check-email?email=periptest${i}@throttle.example`)
        .set("X-Forwarded-For", ip);
      expect(r.status).toBe(200);
    }

    // Sixth request from the same IP with a brand-new email address must still
    // be blocked because the per-IP budget is exhausted.
    const r = await request(app)
      .get("/check-email?email=peripfresh@throttle.example")
      .set("X-Forwarded-For", ip);
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/too many email checks/i);
  });

  it("different email addresses have independent per-email budgets", async () => {
    // maxPerEmail=3, so the 4th request for the same email is blocked.
    // A different email address must still have its full budget available.
    const app = buildApp({ windowMs: 60_000, maxPerEmail: 3, maxPerIp: 100 });

    const emailA = "budget-a@throttle.example";
    const emailB = "budget-b@throttle.example";

    // Exhaust email A's budget.
    for (let i = 0; i < 3; i++) {
      const r = await request(app).get(
        `/check-email?email=${encodeURIComponent(emailA)}`,
      );
      expect(r.status).toBe(200);
    }
    const blockedA = await request(app).get(
      `/check-email?email=${encodeURIComponent(emailA)}`,
    );
    expect(blockedA.status).toBe(429);

    // Email B is a separate key — its budget is untouched.
    const allowedB = await request(app).get(
      `/check-email?email=${encodeURIComponent(emailB)}`,
    );
    expect(allowedB.status).toBe(200);
  });

  it("different email addresses share the per-IP budget", async () => {
    // maxPerIp=4; requests from the same IP across different emails all count
    // against the same IP bucket.
    const app = buildApp({ windowMs: 60_000, maxPerEmail: 100, maxPerIp: 4 });
    const ip = "10.0.2.2";

    for (let i = 0; i < 4; i++) {
      const r = await request(app)
        .get(`/check-email?email=shared-ip-${i}@throttle.example`)
        .set("X-Forwarded-For", ip);
      expect(r.status).toBe(200);
    }

    // Fifth request from the same IP — even with a fresh email — must be
    // blocked because the shared IP budget is exhausted.
    const r = await request(app)
      .get("/check-email?email=shared-ip-new@throttle.example")
      .set("X-Forwarded-For", ip);
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/too many email checks/i);
  });

  it("falls through without throttling when email query param is absent", async () => {
    // maxPerEmail=1 so any second request for the same email would 429; but
    // when there's no email param the middleware must skip and let the handler
    // run normally (the handler itself is responsible for the 400 in the real
    // route — here it returns 200 so we can confirm pass-through).
    const app = buildApp({ windowMs: 60_000, maxPerEmail: 1, maxPerIp: 1 });

    const r = await request(app).get("/check-email");
    expect(r.status).toBe(200);
  });
});
