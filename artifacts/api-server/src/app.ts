import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "node:path";
import { ZodError } from "zod";
import router from "./routes";
import { corsOptions } from "./lib/cors";
import { requireCsrf } from "./middlewares/csrf";
import { logger } from "./lib/logger";
import { HttpError } from "./lib/http";
import { startStatementScheduler } from "./lib/statements";
import { startDailyOrphanedMediaCleanup } from "./lib/case-media";
import { startDailyOneDriveBackup } from "./lib/backup";
import {
  openDesktopInstallerStream,
  type DesktopInstallerKind,
} from "./lib/desktop-installer-storage";

const app: Express = express();
app.set("trust proxy", 1);

// Redirect legacy unauthenticated case-media URLs to the authenticated API
// endpoint. Existing attachment records may have storageKey values of the form
// "https://host/uploads/case-media/<filename>". Those URLs now hit this handler
// instead of the (removed) public static mount, so authorised clients that
// follow redirects are transparently routed to the authenticated compat route.
// No credentials are validated here — auth is enforced by the redirect target.
app.use("/uploads/case-media", (req: Request, res: Response) => {
  const filename = path.basename(req.path);
  if (!filename || filename === "." || filename.includes("..")) {
    return res.status(400).json({ ok: false, message: "Invalid path." });
  }
  return res.redirect(302, `/api/cases/attachment-file/${encodeURIComponent(filename)}`);
});

// Serve the Windows installers for download (outside /api, no auth required).
// The files live in App Storage and are uploaded by an admin (via the upload
// endpoint or the upload-desktop-installer script) so they survive deploys.
function serveInstaller(
  kind: DesktopInstallerKind,
  missingMessage: string,
): (req: Request, res: Response) => Promise<void> {
  return async (_req: Request, res: Response) => {
    try {
      const obj = await openDesktopInstallerStream(kind);
      if (!obj) {
        res.status(404).json({ ok: false, message: missingMessage });
        return;
      }
      res.setHeader("Content-Type", obj.contentType);
      if (obj.size > 0) res.setHeader("Content-Length", String(obj.size));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${obj.fileName}"`,
      );
      res.setHeader("Cache-Control", "no-store");
      obj.stream.on("error", (err) => {
        logger.error({ err, kind }, "Desktop installer stream error");
        if (!res.headersSent) {
          res.status(500).json({ ok: false, message: "Failed to stream installer." });
        } else {
          res.destroy(err);
        }
      });
      obj.stream.pipe(res);
    } catch (err) {
      logger.error({ err, kind }, "Desktop installer download failed");
      if (!res.headersSent) {
        res
          .status(500)
          .json({ ok: false, message: (err as Error)?.message || "Download failed." });
      }
    }
  };
}

app.get(
  "/downloads/LabTrax-Windows-Portable.zip",
  serveInstaller(
    "zip",
    "The Windows portable zip has not been uploaded yet. An admin must upload LabTrax-Windows-Portable.zip via Settings → Desktop App.",
  ),
);
app.get(
  "/downloads/LabTrax-Setup.exe",
  serveInstaller(
    "exe",
    "The Windows installer has not been uploaded yet. An admin must upload LabTrax-Setup.exe via Settings → Desktop App.",
  ),
);

// Reject any other /downloads/* path with a clear 404 (legacy static mount removed).
app.get("/downloads/{*rest}", (_req: Request, res: Response) => {
  res.status(404).json({ ok: false, message: "Not found." });
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

app.use("/api", requireCsrf, router);

startStatementScheduler();
startDailyOrphanedMediaCleanup();
// OneDrive backup scheduler — only active when the connector is available.
if (process.env.REPLIT_CONNECTORS_HOSTNAME) {
  startDailyOneDriveBackup();
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res
      .status(400)
      .json({ ok: false, message: "Invalid request.", errors: err.issues });
  }
  if (err instanceof HttpError) {
    return res
      .status(err.statusCode)
      .json({ ok: false, message: err.message, details: err.details });
  }
  logger.error({ err }, "Unhandled API error");
  return res
    .status(500)
    .json({ ok: false, message: (err as Error)?.message || "Server error." });
});

export default app;
