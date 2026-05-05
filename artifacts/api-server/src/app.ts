import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "node:path";
import { ZodError } from "zod";
import router from "./routes";
import { corsOptions } from "./lib/cors";
import { logger } from "./lib/logger";
import { HttpError } from "./lib/http";
import { startStatementScheduler } from "./lib/statements";

const app: Express = express();
app.set("trust proxy", 1);

// Serve uploaded case media files directly (outside /api prefix)
const casMediaDir = path.join(process.cwd(), "uploads", "case-media");
app.use("/uploads/case-media", express.static(casMediaDir));

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

app.use("/api", router);

startStatementScheduler();

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
