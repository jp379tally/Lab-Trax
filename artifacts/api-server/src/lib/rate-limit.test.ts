import type { Request } from "express";
import express from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRateLimit,
  createUserAndDestinationRateLimit,
  createUserRateLimit,
  getClientIp,
} from "./rate-limit.js";

describe("getClientIp", () => {
  it("uses Express's resolved client IP instead of parsing the forwarded header", () => {
    const req = {
      ip: "203.0.113.20",
      headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.20" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;

    expect(getClientIp(req)).toBe("203.0.113.20");
  });

  it("falls back to the socket address if Express has no resolved IP", () => {
    const req = {
      ip: "",
      headers: { "x-forwarded-for": "198.51.100.99" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;

    expect(getClientIp(req)).toBe("127.0.0.1");
  });
});

describe("authentication rate-limit identity", () => {
  let savedVitest: string | undefined;

  beforeEach(() => {
    savedVitest = process.env["VITEST"];
    delete process.env["VITEST"];
  });

  afterEach(() => {
    if (savedVitest !== undefined) process.env["VITEST"] = savedVitest;
    else delete process.env["VITEST"];
  });

  it("keeps login attempts in one bucket when a caller changes the untrusted XFF prefix", async () => {
    const app = express();
    app.set("trust proxy", 1);
    const routePath = `/login-${randomUUID()}`;
    app.post(
      routePath,
      createRateLimit({ windowMs: 60_000, max: 1 }),
      (_req, res) => res.json({ ok: true }),
    );

    const first = await request(app)
      .post(routePath)
      .set("X-Forwarded-For", "198.51.100.10, 203.0.113.20");
    expect(first.status).toBe(200);

    const changedPrefix = await request(app)
      .post(routePath)
      .set("X-Forwarded-For", "198.51.100.11, 203.0.113.20");
    expect(changedPrefix.status).toBe(429);
  });

  it("throttles username availability checks after the configured per-IP budget", async () => {
    const app = express();
    app.set("trust proxy", 1);
    const routePath = `/check-username-${randomUUID()}`;
    app.post(
      routePath,
      createRateLimit({
        windowMs: 60_000,
        max: 5,
        message: "Too many username availability checks. Please try again later.",
      }),
      (_req, res) => res.json({ available: true }),
    );

    for (let i = 0; i < 5; i++) {
      const response = await request(app)
        .post(routePath)
        .set("X-Forwarded-For", "203.0.113.77")
        .send({ username: `user${i}` });
      expect(response.status).toBe(200);
    }

    const blocked = await request(app)
      .post(routePath)
      .set("X-Forwarded-For", "203.0.113.77")
      .send({ username: "another-user" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many username availability checks/i);
  });

  it("throttles authenticated unlock attempts by user, regardless of forwarded headers", async () => {
    const app = express();
    const limiter = createUserRateLimit({ windowMs: 60_000, max: 1 });
    app.use((req, _res, next) => {
      (req as Request & { user?: { id: string } }).user = { id: "unlock-admin-test-user" };
      next();
    });
    app.post("/unlock", limiter, (_req, res) => res.json({ ok: true }));

    const first = await request(app)
      .post("/unlock")
      .set("X-Forwarded-For", "198.51.100.10")
      .send({ credential: "wrong" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/unlock")
      .set("X-Forwarded-For", "198.51.100.11")
      .send({ credential: "wrong" });
    expect(second.status).toBe(429);
    expect(second.body.ok).toBe(false);
    expect(second.headers["retry-after"]).toBeDefined();
  });
});

describe("user and destination rate limiting", () => {
  it("limits one sender and shares a destination budget across senders", () => {
    const check = createUserAndDestinationRateLimit({
      windowMs: 60_000,
      maxPerUser: 2,
      maxPerDestination: 2,
    });

    expect(check("sender-a", "+15550000001")).toBeNull();
    expect(check("sender-b", "+15550000001")).toBeNull();

    const destinationLimit = check("sender-c", "+15550000001");
    expect(destinationLimit?.scope).toBe("destination");
    expect(destinationLimit?.retryAfter).toBeGreaterThan(0);

    expect(check("sender-a", "+15550000002")).toBeNull();
    const userLimit = check("sender-a", "+15550000003");
    expect(userLimit?.scope).toBe("user");
    expect(userLimit?.retryAfter).toBeGreaterThan(0);
  });
});
