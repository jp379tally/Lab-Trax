import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import healthRouter from "./health";
import { registerRoutes } from "./labtrax-routes";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Health routes are always available, even before the LabTrax routes finish
// initialising, so the platform's port-open / health checks pass immediately.
router.use(healthRouter);

// LabTrax routes are initialised asynchronously at startup. Until they are
// mounted, gate all non-health API traffic behind a clear 503 "API starting"
// response instead of leaking 404s for every route during the gap. If
// registration fails we log loudly and exit, rather than silently serving
// health-only forever.
let labtraxReady = false;

router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!labtraxReady) {
    res.setHeader("Retry-After", "5");
    res.status(503).json({ ok: false, message: "API starting, please retry shortly." });
    return;
  }
  next();
});

registerRoutes()
  .then((labtraxRouter) => {
    router.use(labtraxRouter);
    labtraxReady = true;
    logger.info("LabTrax routes mounted — API ready");
  })
  .catch((err) => {
    // Fail loudly and exit so the platform restarts us, instead of running
    // health-only forever with every real request returning 503.
    process.stderr.write(
      `[startup] FATAL: LabTrax route registration failed: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }\n`,
    );
    logger.fatal({ err }, "LabTrax route registration failed — exiting");
    process.exit(1);
  });

export default router;
