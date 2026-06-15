import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

export function createRateLimit(opts: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Rate limiting is a production safeguard. Disable it under Vitest: test
    // suites register/login many times from a single loopback IP and share this
    // in-process store across files within a fork, which would otherwise throttle
    // unrelated tests in an order-dependent way. No test asserts 429 here.
    if (process.env["VITEST"]) {
      next();
      return;
    }

    const ip = getClientIp(req);
    const key = `${req.path}:${ip}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      store.set(key, entry);
    }
    entry.count++;

    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, opts.max - entry.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > opts.max) {
      res.status(429).json({
        error: opts.message ?? "Too many requests. Please try again later.",
      });
      return;
    }

    next();
  };
}
