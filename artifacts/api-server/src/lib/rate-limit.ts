import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Tracks the last time a code was issued for a given (channel, identifier) pair
// so we can enforce a resend cooldown independently of the rolling window.
const cooldownStore = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
  for (const [key, last] of cooldownStore.entries()) {
    // Drop cooldown markers well past any plausible cooldown window.
    if (now - last > 60 * 60 * 1000) cooldownStore.delete(key);
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

/**
 * Per-user rate limiter for authenticated endpoints.
 *
 * Unlike {@link createRateLimit} (which is IP-keyed and disabled under Vitest),
 * this limiter keys on the authenticated user's ID so it is fair across
 * shared-IP networks. It is intentionally NOT disabled under Vitest so that
 * tests can assert 429 behaviour; each call to this function creates an
 * independent in-closure store, making it safe to instantiate once per route
 * at module load time without cross-test bleed when tests inject fresh
 * instances.
 *
 * The middleware must be placed after an auth middleware that sets `req.user`.
 * If `req.user` is absent the request is allowed through (the auth middleware
 * is responsible for rejecting unauthenticated traffic).
 */
export function createUserRateLimit(opts: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  const userStore = new Map<string, RateLimitEntry>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of userStore.entries()) {
      if (entry.resetAt < now) userStore.delete(key);
    }
  }, 5 * 60 * 1000);
  cleanup.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    if (!userId) {
      next();
      return;
    }

    const now = Date.now();
    let entry = userStore.get(userId);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      userStore.set(userId, entry);
    }
    entry.count++;

    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, opts.max - entry.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        ok: false,
        error: opts.message ?? "Too many requests. Please try again later.",
      });
      return;
    }

    next();
  };
}

/**
 * Dual-key rate limiter for `GET /api/auth/check-email`.
 *
 * Two independent limits are enforced before the handler runs:
 *  1. **Per-email** — at most `maxPerEmail` requests per `windowMs` for the
 *     same canonicalised email value (stops targeted enumeration of a single
 *     address).
 *  2. **Per-IP** — at most `maxPerIp` requests per `windowMs` from the same
 *     source IP (stops one host spraying many addresses).
 *
 * Like {@link createRateLimit}, this is disabled under Vitest to avoid
 * order-dependent throttling across test files.
 *
 * If the query string contains no usable `email` value the request falls
 * through so the handler can return its own 400.
 */
export function createCheckEmailThrottle(opts: {
  windowMs: number;
  maxPerEmail: number;
  maxPerIp: number;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (process.env["VITEST"]) {
      next();
      return;
    }

    const rawEmail = typeof req.query?.["email"] === "string" ? req.query["email"] : "";
    const email = rawEmail.trim().toLowerCase();
    if (!email) {
      next();
      return;
    }

    const ip = getClientIp(req);
    const now = Date.now();

    const reject = (message: string): void => {
      res.status(429).json({ error: message });
    };

    // 1. Per-email rolling window.
    const emailKey = `checkEmail:email:${email}`;
    let emailEntry = store.get(emailKey);
    if (!emailEntry || emailEntry.resetAt < now) {
      emailEntry = { count: 0, resetAt: now + opts.windowMs };
      store.set(emailKey, emailEntry);
    }
    emailEntry.count++;
    if (emailEntry.count > opts.maxPerEmail) {
      reject("Too many email checks for this address. Please wait a minute and try again.");
      return;
    }

    // 2. Per-IP rolling window.
    const ipKey = `checkEmail:ip:${ip}`;
    let ipEntry = store.get(ipKey);
    if (!ipEntry || ipEntry.resetAt < now) {
      ipEntry = { count: 0, resetAt: now + opts.windowMs };
      store.set(ipKey, ipEntry);
    }
    ipEntry.count++;
    if (ipEntry.count > opts.maxPerIp) {
      reject("Too many email checks. Please wait a minute and try again.");
      return;
    }

    next();
  };
}

/**
 * Abuse control for the public-ish verification-code send endpoints
 * (`/api/send-email-code`, `/api/send-phone-code`). Each outbound request can
 * trigger a real email/SMS, so these are a denial-of-service and cost-abuse
 * surface. This middleware enforces three layers before the handler ever runs
 * (so no email/SMS is dispatched once throttled):
 *
 *  1. **Resend cooldown** — the same identifier (email/phone) cannot request a
 *     fresh code more than once per `cooldownMs`.
 *  2. **Per-identifier window** — at most `maxPerIdentifier` codes per identifier
 *     within `windowMs` (stops hammering a single victim).
 *  3. **Per-IP window** — at most `maxPerIp` codes per source IP within
 *     `windowMs` (stops one host spraying many identifiers).
 *
 * Unlike {@link createRateLimit}, this is NOT disabled under Vitest: it is keyed
 * on the (channel, identifier) and (channel, ip) pair, so tests using distinct
 * identifiers / `X-Forwarded-For` values exercise it deterministically without
 * cross-test bleed. Requests missing an identifier fall through so the handler
 * can return its own 400.
 */
export function createSendCodeThrottle(opts: {
  channel: string;
  field: "email" | "phone";
  cooldownMs: number;
  windowMs: number;
  maxPerIdentifier: number;
  maxPerIp: number;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = (req.body as Record<string, unknown> | undefined)?.[opts.field];
    if (typeof raw !== "string" || !raw.trim()) {
      next();
      return;
    }

    const identifier =
      opts.field === "email" ? raw.trim().toLowerCase() : raw.replace(/\D/g, "");
    if (!identifier) {
      next();
      return;
    }

    const ip = getClientIp(req);
    const now = Date.now();

    const reject = (retryAfterMs: number, message: string): void => {
      const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: message });
    };

    // 1. Resend cooldown (per identifier).
    const cooldownKey = `${opts.channel}:${identifier}`;
    const last = cooldownStore.get(cooldownKey);
    if (last !== undefined && now - last < opts.cooldownMs) {
      reject(
        opts.cooldownMs - (now - last),
        "Please wait before requesting another verification code."
      );
      return;
    }

    // 2. Per-identifier rolling window.
    const idKey = `sendcode:id:${opts.channel}:${identifier}`;
    let idEntry = store.get(idKey);
    if (!idEntry || idEntry.resetAt < now) {
      idEntry = { count: 0, resetAt: now + opts.windowMs };
      store.set(idKey, idEntry);
    }
    idEntry.count++;
    if (idEntry.count > opts.maxPerIdentifier) {
      reject(
        idEntry.resetAt - now,
        "Too many verification codes requested for this contact. Please try again later."
      );
      return;
    }

    // 3. Per-IP rolling window.
    const ipKey = `sendcode:ip:${opts.channel}:${ip}`;
    let ipEntry = store.get(ipKey);
    if (!ipEntry || ipEntry.resetAt < now) {
      ipEntry = { count: 0, resetAt: now + opts.windowMs };
      store.set(ipKey, ipEntry);
    }
    ipEntry.count++;
    if (ipEntry.count > opts.maxPerIp) {
      reject(
        ipEntry.resetAt - now,
        "Too many verification code requests. Please try again later."
      );
      return;
    }

    // Allowed — record the issue time for the cooldown gate ONLY after the
    // handler completes successfully (2xx). If the SMS/email send fails the
    // handler returns a non-2xx status and we must NOT consume the user's
    // 30-second window, so they can retry immediately.
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cooldownStore.set(cooldownKey, Date.now());
      }
    });
    next();
  };
}
