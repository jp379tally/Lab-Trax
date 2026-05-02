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
    // Multi-device lab sharing: ensure organization_id is on lab_cases and the
    // shared lab_pending_files table exists so cases and drag-dropped files
    // sync across every member of a lab.
    await db.execute(
      sql`ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS organization_id varchar`
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS lab_cases_org_idx ON lab_cases (organization_id)`
    );
    await db.execute(
      sql`
        CREATE TABLE IF NOT EXISTS lab_pending_files (
          id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id varchar NOT NULL,
          uploader_user_id varchar NOT NULL,
          uploader_name text NOT NULL,
          file_url text NOT NULL,
          file_name text NOT NULL,
          mime_type text,
          notes text,
          created_at timestamp DEFAULT now() NOT NULL
        )
      `
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS lab_pending_files_org_idx ON lab_pending_files (organization_id)`
    );

    // Backfill organization_id on legacy lab_cases rows that were saved before
    // we started populating the column. Visibility is now decided purely from
    // this column, so any case stuck with a NULL organization_id but a valid
    // affiliationKey in its case_data JSON would silently disappear from
    // every lab member's view. Two passes:
    //   1. Pull the UUID directly out of "org:<UUID>" affiliationKey values.
    //   2. Fall back to matching affiliationName against organizations by
    //      display_name or name — but ONLY when the match is unambiguous, so
    //      two labs that happen to share a display name never silently leak
    //      cases between them.
    // Both passes are idempotent (touch only rows with NULL organization_id).
    //
    // We define a `try_to_jsonb(text)` helper that returns NULL on parse
    // failure instead of aborting the entire UPDATE. This makes the backfill
    // robust against any malformed legacy JSON payload, no matter how it's
    // shaped — a single bad row can never block the migration.
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION try_to_jsonb(input text)
      RETURNS jsonb
      LANGUAGE plpgsql
      IMMUTABLE
      AS $$
      BEGIN
        RETURN input::jsonb;
      EXCEPTION WHEN others THEN
        RETURN NULL;
      END;
      $$;
    `);
    // REMEDIATION: NULL out organization_id values that point at
    // organizations that no longer exist (or aren't of type 'lab'). Such
    // rows are invisible to EVERYONE — the owner cannot see them
    // (organization_id IS NOT NULL fails the private branch) and no lab
    // member sees them because the lab doesn't exist. Idempotent.
    //
    // We deliberately DO NOT remediate based on the owner's lab
    // membership here. Domain rule for dental-lab fulfillment: a scanner
    // (who may not be a member of the receiving lab) is allowed to drop
    // a case into that lab's inbox. Stripping organization_id when the
    // owner isn't a member would silently hide cases the lab is supposed
    // to fulfill — the exact regression that broke SDR1 visibility.
    await db.execute(sql`
      UPDATE lab_cases lc
      SET organization_id = NULL
      WHERE lc.organization_id IS NOT NULL
        AND lc.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM organizations o
          WHERE o.id = lc.organization_id AND o.type = 'lab'
        )
    `);

    // Backfill passes promote a case into a lab when its
    // affiliationKey/affiliationName JSON points at a real lab. The only
    // safety rail is that the target organization exists as an active
    // lab — we no longer require the case owner to be a member of that
    // lab, because in this product anyone can scan a case for any lab's
    // inbox. Both passes are idempotent (they only touch rows whose
    // organization_id is currently NULL).
    await db.execute(sql`
      UPDATE lab_cases lc
      SET organization_id = o.id
      FROM organizations o
      WHERE lc.organization_id IS NULL
        AND lc.deleted_at IS NULL
        AND lc.case_data IS NOT NULL
        AND lc.case_data <> ''
        AND try_to_jsonb(lc.case_data) IS NOT NULL
        AND (try_to_jsonb(lc.case_data) ->> 'affiliationKey') LIKE 'org:%'
        AND length(try_to_jsonb(lc.case_data) ->> 'affiliationKey') > 4
        AND o.type = 'lab'
        AND o.id::text = trim(substring((try_to_jsonb(lc.case_data) ->> 'affiliationKey') from 5))
    `);
    await db.execute(sql`
      WITH unambiguous_lab_names AS (
        SELECT lower(coalesce(display_name, name)) AS normalized_name,
               min(id) AS lab_id
        FROM organizations
        WHERE type = 'lab'
          AND coalesce(display_name, name) IS NOT NULL
        GROUP BY lower(coalesce(display_name, name))
        HAVING count(*) = 1
      )
      UPDATE lab_cases lc
      SET organization_id = u.lab_id
      FROM unambiguous_lab_names u
      WHERE lc.organization_id IS NULL
        AND lc.deleted_at IS NULL
        AND lc.case_data IS NOT NULL
        AND lc.case_data <> ''
        AND try_to_jsonb(lc.case_data) IS NOT NULL
        AND lower(coalesce(try_to_jsonb(lc.case_data) ->> 'affiliationName', '')) <> ''
        AND lower(try_to_jsonb(lc.case_data) ->> 'affiliationName') = u.normalized_name
    `);

    // ONE-TIME MERGE: SDR1 duplicate-lab consolidation.
    // Two organizations both ended up with display_name="SDR1":
    //   SOURCE a9877ba7-... (1 case, 3 members)
    //   TARGET fe67257e-... (45 cases, 2 members)
    // Members of SOURCE could not see TARGET's 45 cases, even though the
    // user thought everyone was in "SDR1". Per user instruction, merge
    // SOURCE into TARGET and delete SOURCE. Idempotent: the IF guard
    // skips this block once SOURCE no longer exists.
    await db.execute(sql`
      DO $$
      DECLARE
        src_id text := 'a9877ba7-dea7-4021-9959-a29b65d62d39';
        tgt_id text := 'fe67257e-5cc5-4489-afc9-62afb5b9829c';
      BEGIN
        IF EXISTS (SELECT 1 FROM organizations WHERE id = src_id)
           AND EXISTS (SELECT 1 FROM organizations WHERE id = tgt_id) THEN

          INSERT INTO lab_memberships (lab_id, user_id, role, status, joined_at, approved_by_user_id)
          SELECT tgt_id, user_id, role, status, COALESCE(joined_at, now()), approved_by_user_id
          FROM lab_memberships
          WHERE lab_id = src_id
          ON CONFLICT (lab_id, user_id) DO NOTHING;

          DELETE FROM lab_memberships WHERE lab_id = src_id;

          UPDATE lab_cases
          SET organization_id = tgt_id,
              case_data = REPLACE(case_data, 'org:' || src_id, 'org:' || tgt_id)
          WHERE organization_id = src_id AND deleted_at IS NULL;

          UPDATE lab_cases
          SET case_data = REPLACE(case_data, 'org:' || src_id, 'org:' || tgt_id)
          WHERE case_data LIKE '%org:' || src_id || '%';

          UPDATE audit_logs SET organization_id = tgt_id WHERE organization_id = src_id;

          DELETE FROM join_requests WHERE lab_id = src_id;
          DELETE FROM lab_invites WHERE lab_id = src_id;

          DELETE FROM organizations WHERE id = src_id;

          RAISE NOTICE 'SDR1 duplicate-lab merge complete (source=% -> target=%)', src_id, tgt_id;
        END IF;
      END $$;
    `);

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
})();
