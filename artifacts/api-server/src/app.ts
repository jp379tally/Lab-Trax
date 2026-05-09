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
  getDesktopInstallerHandle,
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

// Serve the desktop installers for download (Windows zip + exe, macOS dmg)
// outside /api with no auth required. The files live in App Storage and are
// uploaded by an admin (via the upload endpoint, the upload-desktop-installer
// script, or the CI auto-publish steps) so they survive deploys.
// Parse a single-range HTTP `Range` header of the form `bytes=start-end`.
// Returns { start, end } (inclusive) on success, "invalid" if the header is
// malformed / unsatisfiable for the given size (caller should respond with
// 416), or null if there is no Range header (caller should serve the full
// file). Multi-range requests (`bytes=0-99,200-299`) are not supported and
// fall into the "invalid" path, which matches the rest of the malformed-
// header handling.
function parseRangeHeader(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return "invalid";
  const startStr = match[1];
  const endStr = match[2];
  if (size <= 0) return "invalid";
  let start: number;
  let end: number;
  if (startStr === "" && endStr === "") return "invalid";
  if (startStr === "") {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr === "" ? size - 1 : Number.parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  }
  if (start < 0 || end < start || start >= size) return "invalid";
  if (end >= size) end = size - 1;
  return { start, end };
}

function serveInstaller(
  kind: DesktopInstallerKind,
  missingMessage: string,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    try {
      const handle = await getDesktopInstallerHandle(kind);
      if (!handle) {
        res.setHeader("Cache-Control", "no-store");
        res.status(404).json({ ok: false, message: missingMessage });
        return;
      }

      // Common headers for both 200 and 206 responses. The installer is
      // immutable for a given (size, uploadedAt) pair so the strong ETag is
      // safe to use for conditional requests and resumable downloads.
      res.setHeader("Content-Type", handle.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${handle.fileName}"`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("ETag", handle.etag);
      const lastModified = new Date(handle.uploadedAt);
      if (!Number.isNaN(lastModified.getTime())) {
        res.setHeader("Last-Modified", lastModified.toUTCString());
      }
      // Allow short-lived caching but force revalidation so a freshly
      // uploaded installer is picked up promptly.
      res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");

      // Conditional GET: if the client already has the current installer,
      // skip the body.
      const ifNoneMatch = req.headers["if-none-match"];
      if (typeof ifNoneMatch === "string" && ifNoneMatch.split(",").map((s) => s.trim()).includes(handle.etag)) {
        res.status(304).end();
        return;
      }

      // Range handling.
      const rawRange = req.headers["range"];
      const rangeHeader = Array.isArray(rawRange) ? rawRange[0] : rawRange;
      const parsed = parseRangeHeader(rangeHeader, handle.size);

      if (parsed === "invalid") {
        res.setHeader("Content-Range", `bytes */${handle.size}`);
        res.status(416).json({ ok: false, message: "Requested range not satisfiable." });
        return;
      }

      // If the client sent `If-Range` and it doesn't match our ETag, ignore the
      // Range header and serve the full body so the client doesn't stitch
      // together mismatched bytes.
      const ifRange = req.headers["if-range"];
      const honorRange =
        parsed !== null && (typeof ifRange !== "string" || ifRange.trim() === handle.etag);

      const range = honorRange ? parsed : null;
      const isPartial = range !== null;
      const start = isPartial ? range.start : 0;
      const end = isPartial ? range.end : Math.max(handle.size - 1, 0);
      const contentLength = handle.size > 0 ? end - start + 1 : 0;

      if (isPartial) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${handle.size}`);
      } else {
        res.status(200);
      }
      if (handle.size > 0) {
        res.setHeader("Content-Length", String(contentLength));
      }

      // HEAD requests get headers only.
      if (req.method === "HEAD") {
        res.end();
        return;
      }

      const obj = await openDesktopInstallerStream(
        kind,
        isPartial ? { start, end } : undefined,
      );
      if (!obj) {
        // Vanishingly rare: the installer was deleted between handle and stream
        // open. We've already sent headers above, so just close the response.
        if (!res.headersSent) {
          res.setHeader("Cache-Control", "no-store");
          res.status(404).json({ ok: false, message: missingMessage });
        } else {
          res.destroy();
        }
        return;
      }

      let bytesSent = 0;
      let upstreamFailed = false;
      obj.stream.on("data", (chunk: Buffer | string) => {
        bytesSent += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      });
      obj.stream.on("error", (err) => {
        upstreamFailed = true;
        logger.error(
          { err, kind, bytesSent, range: isPartial ? `${start}-${end}` : "full" },
          "Desktop installer stream error",
        );
        // Headers are already sent (we set status above), so we cannot send a
        // JSON error. Close the underlying socket so the client treats the
        // response as truncated and can issue a Range-based resume.
        try {
          obj.stream.unpipe(res);
        } catch {
          // ignore
        }
        if (!res.writableEnded) {
          res.destroy(err);
        }
      });
      // If the client disconnects mid-transfer, stop pulling bytes from the
      // upstream stream so we don't leak resources or keep the upstream open.
      const cleanupUpstream = () => {
        const maybeDestroy = (obj.stream as unknown as { destroy?: () => void }).destroy;
        if (typeof maybeDestroy === "function") {
          maybeDestroy.call(obj.stream);
        }
      };
      res.on("close", () => {
        if (!res.writableEnded || upstreamFailed) {
          cleanupUpstream();
        }
      });
      obj.stream.pipe(res);
    } catch (err) {
      logger.error({ err, kind }, "Desktop installer download failed");
      if (!res.headersSent) {
        res.setHeader("Cache-Control", "no-store");
        res
          .status(500)
          .json({ ok: false, message: (err as Error)?.message || "Download failed." });
      } else if (!res.writableEnded) {
        res.destroy(err as Error);
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
app.get(
  "/downloads/LabTrax.dmg",
  serveInstaller(
    "dmg",
    "The macOS installer has not been uploaded yet. An admin must upload LabTrax.dmg via Settings → Desktop App.",
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
