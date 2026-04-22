import express from "express";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { hashPassword } from "./lib/crypto";
import { db } from "./db";
import { users } from "../shared/schema";
import { eq, sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

const app = express();
const log = console.log;
const DEMO_ACCOUNTS_ENABLED = process.env.LABTRAX_ENABLE_DEMO_SEEDS === "true";
const SENSITIVE_LOG_KEYS = new Set([
  "accessToken",
  "refreshToken",
  "password",
  "token",
  "demoCode",
  "demoResetLink",
  "adminKey",
]);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

function redactSensitivePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitivePayload(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_LOG_KEYS.has(key) ? "[REDACTED]" : redactSensitivePayload(entry),
      ]),
    );
  }

  return value;
}

function setupCors(app: express.Application) {
  app.use((req, res, next) => {
    const origins = new Set<string>();

    if (process.env.REPLIT_DEV_DOMAIN) {
      origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }

    if (process.env.REPLIT_DOMAINS) {
      process.env.REPLIT_DOMAINS.split(",").forEach((d) => {
        origins.add(`https://${d.trim()}`);
      });
    }

    const origin = req.header("origin");

    // Allow localhost origins for Expo web development (any port)
    const isLocalhost =
      origin?.startsWith("http://localhost:") ||
      origin?.startsWith("http://127.0.0.1:");

    if (origin && (origins.has(origin) || isLocalhost)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.header("Access-Control-Allow-Credentials", "true");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }

    next();
  });
}

function setupBodyParsing(app: express.Application) {
  app.use(
    express.json({
      limit: "50mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(express.urlencoded({ extended: false, limit: "50mb" }));
}

function setupRequestLogging(app: express.Application) {
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      if (!path.startsWith("/api")) return;

      const duration = Date.now() - start;

      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(redactSensitivePayload(capturedJsonResponse))}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      logLine = logLine.replace("â€¦", "...");
      logLine = logLine.replace(/[^\x20-\x7E]+$/, "...");
      log(logLine);
    });

    next();
  });
}

function getAppName(): string {
  try {
    const appJsonPath = path.resolve(process.cwd(), "app.json");
    const appJsonContent = fs.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}

function serveExpoManifest(platform: string, req: Request, res: Response) {
  const manifestPath = path.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json",
  );

  if (!fs.existsSync(manifestPath)) {
    return res
      .status(404)
      .json({ error: `Manifest not found for platform: ${platform}` });
  }

  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");

  let manifest = fs.readFileSync(manifestPath, "utf-8");

  const forwardedHost = req.header("x-forwarded-host");
  const actualHost = forwardedHost || req.get("host");
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const actualBaseUrl = `${protocol}://${actualHost}`;

  manifest = manifest.replace(/https?:\/\/[^"]*?janeway\.replit\.dev(?::\d+)?/g, actualBaseUrl);
  manifest = manifest.replace(/http:\/\/127\.0\.0\.1:\d+/g, actualBaseUrl);
  manifest = manifest.replace(/http:\/\/localhost:\d+/g, actualBaseUrl);

  res.send(manifest);
}

function serveLandingPage({
  req,
  res,
  landingPageTemplate,
  appName,
}: {
  req: Request;
  res: Response;
  landingPageTemplate: string;
  appName: string;
}) {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;

  log(`baseUrl`, baseUrl);
  log(`expsUrl`, expsUrl);

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, appName);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}

function configureExpoAndLanding(app: express.Application) {
  const templatePath = path.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html",
  );
  const landingPageTemplate = fs.readFileSync(templatePath, "utf-8");
  const appName = getAppName();

  log("Serving static Expo files with dynamic manifest routing");

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api")) {
      return next();
    }

    if (req.path === "/smile-preview") {
      const smilePath = path.resolve(process.cwd(), "server", "templates", "smile-preview.html");
      if (fs.existsSync(smilePath)) {
        return res.sendFile(smilePath);
      }
    }

    if (req.path === "/reset-password") {
      const resetPath = path.resolve(process.cwd(), "server", "templates", "reset-password.html");
      if (fs.existsSync(resetPath)) {
        return res.sendFile(resetPath);
      }
    }

    if (req.path === "/privacy-policy" || req.path === "/privacy") {
      const privacyPath = path.resolve(process.cwd(), "server", "templates", "privacy-policy.html");
      if (fs.existsSync(privacyPath)) {
        return res.sendFile(privacyPath);
      }
    }

    if (req.path === "/terms-of-service" || req.path === "/terms") {
      const termsPath = path.resolve(process.cwd(), "server", "templates", "terms-of-service.html");
      if (fs.existsSync(termsPath)) {
        return res.sendFile(termsPath);
      }
    }

    if (req.path === "/app") {
      const indexPath = path.resolve(process.cwd(), "static-build", "index.html");
      if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
      }
      const devDomain = process.env.REPLIT_DEV_DOMAIN;
      if (devDomain) {
        return res.redirect(`https://${devDomain}:8081`);
      }
      return res.redirect("/");
    }

    if (req.path.startsWith("/app/")) {
      return next();
    }

    if (req.path !== "/" && req.path !== "/manifest") {
      return next();
    }

    const platform = req.header("expo-platform");
    if (platform && (platform === "ios" || platform === "android")) {
      return serveExpoManifest(platform, req, res);
    }

    if (req.path === "/") {
      return serveLandingPage({
        req,
        res,
        landingPageTemplate,
        appName,
      });
    }

    next();
  });

  app.use("/assets", express.static(path.resolve(process.cwd(), "assets")));
  app.use("/public", express.static(path.resolve(process.cwd(), "public")));
  app.use("/app", express.static(path.resolve(process.cwd(), "static-build")));
  app.use(express.static(path.resolve(process.cwd(), "static-build")));

  const webIndexPath = path.resolve(process.cwd(), "static-build", "index.html");
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" && req.path.startsWith("/app/") && !req.path.includes(".")) {
      if (fs.existsSync(webIndexPath)) {
        return res.sendFile(webIndexPath);
      }
    }
    next();
  });

  log("Expo routing: Checking expo-platform header on / and /manifest");
}

function setupErrorHandler(app: express.Application) {
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }

    const error = err as {
      status?: number;
      statusCode?: number;
      message?: string;
      details?: unknown;
    };

    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";

    if (status >= 500) {
      console.error("Internal Server Error:", err);
    }

    return res.status(status).json({ ok: false, message, ...(error.details ? { details: error.details } : {}) });
  });
}

function setupSecurityHeaders(app: express.Application) {
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (_req.path === "/smile-preview") {
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
    } else {
      res.setHeader("X-Frame-Options", "DENY");
    }
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    next();
  });
}

async function seedDemoAccount() {
  if (!DEMO_ACCOUNTS_ENABLED) {
    return;
  }

  const accounts = [
    { username: "demo_lab_owner", password: "LabTraxDemo#2026", email: "demo_lab_owner@labtrax.local", userType: "lab", role: "admin" },
    { username: "demo_provider_admin", password: "LabTraxDemo#2026", email: "demo_provider_admin@labtrax.local", userType: "provider", role: "admin" },
  ];
  for (const acct of accounts) {
    try {
      const allUsers = await db.select().from(users);
      const existing = allUsers.find(u => u.username.toLowerCase() === acct.username.toLowerCase());
      if (!existing) {
        const hashed = await hashPassword(acct.password);
        await db.insert(users).values({
          username: acct.username,
          password: hashed,
          email: acct.email,
          userType: acct.userType,
          role: acct.role,
          initials: acct.username.slice(0, 2).toUpperCase(),
        });
        log(`Demo account ${acct.username} seeded successfully`);
      }
    } catch (err: any) {
      console.error(`Demo account seed error (${acct.username}):`, err?.message || err);
    }
  }
}

async function runStartupMigrations() {
  try {
    await db.execute(
      sql`DROP INDEX IF EXISTS "join_requests_lab_user_status_unique"`
    );
    await db.execute(
      sql`
        DELETE FROM "join_requests"
        WHERE status = 'pending'
          AND id NOT IN (
            SELECT DISTINCT ON (lab_id, user_id) id
            FROM "join_requests"
            WHERE status = 'pending'
            ORDER BY lab_id, user_id, created_at DESC
          )
      `
    );
    await db.execute(
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS "join_requests_pending_unique"
        ON "join_requests" ("lab_id", "user_id")
        WHERE status = 'pending'
      `
    );
    await db.execute(
      sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS work_status TEXT DEFAULT 'available'`
    );
    log("Startup migrations applied successfully");
  } catch (err: any) {
    console.error("Startup migration error:", err?.message || err);
  }
}

(async () => {
  setupCors(app);
  setupSecurityHeaders(app);
  setupBodyParsing(app);
  setupRequestLogging(app);

  await runStartupMigrations();

  configureExpoAndLanding(app);

  const server = await registerRoutes(app);

  setupErrorHandler(app);

  await seedDemoAccount();

  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`express server serving on port ${port}`);
    },
  );

  // ── Nightly OneDrive backup scheduler ─────────────────────────────────────
  // Runs automatically every 24 hours regardless of whether the app is open.
  // First backup fires ~2 minutes after server start (to let DB settle),
  // then repeats every 24 hours at the same offset.
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const scheduleNightlyBackup = () => {
    const runBackup = async () => {
      log("[Nightly Backup] Starting scheduled backup...");
      const backupFn = (app as any)._runScheduledBackup;
      if (typeof backupFn === "function") {
        const result = await backupFn();
        if (result.success) {
          log(`[Nightly Backup] Success — ${result.fileName} (${((result.size || 0) / 1024 / 1024).toFixed(1)} MB)`);
        } else {
          log(`[Nightly Backup] Failed — ${result.error}`);
        }
      }
    };

    // Wait 2 minutes after startup, then run every 24 h
    setTimeout(async () => {
      await runBackup();
      setInterval(runBackup, TWENTY_FOUR_HOURS);
    }, 2 * 60 * 1000);
  };

  scheduleNightlyBackup();
})();
