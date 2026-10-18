import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { RequestHandler } from "express";
import { pool } from "@workspace/db";
import { withDbRequestTiming } from "@workspace/db/request-timing";
import { logger } from "../lib/logger";

// Fixed-size histogram, no request history or sensitive payloads retained.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
if (process.env.NODE_ENV !== "test") {
  loopDelay.enable();
  let previousCpu = process.cpuUsage();
  let previousAt = performance.now();
  setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    logger.info({
      elapsedMs: Math.round(now - previousAt),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      eventLoopP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
      eventLoopMaxMs: Math.round(loopDelay.max / 1e6),
      poolTotal: pool.totalCount, poolIdle: pool.idleCount, poolWaiting: pool.waitingCount,
    }, "API resource sample");
    previousAt = now;
    loopDelay.reset();
  }, 30_000).unref();
}

export const requestPerformance: RequestHandler = (req, res, next) => {
  const start = performance.now();
  const timing = { checkouts: 0, checkoutMs: 0, maxCheckoutMs: 0 };
  const stages: Record<string, number> = {};
  res.locals.performanceStages = stages;
  req.once("end", () => {
    stages.ingressMs = Math.round(performance.now() - start);
    res.locals.bodyEndedAt = performance.now();
  });
  const writeHead = res.writeHead;
  res.writeHead = function (this: typeof res, ...args: Parameters<typeof writeHead>) {
    res.setHeader("Server-Timing", [
      `server;dur=${Math.round(performance.now() - start)}`,
      `dbCheckout;dur=${Math.round(timing.checkoutMs)}`,
      ...Object.entries(stages).map(([name, duration]) => `${name};dur=${duration}`),
    ].join(", "));
    return writeHead.apply(this, args);
  } as typeof writeHead;
  res.on("finish", () => {
    const durationMs = Math.round(performance.now() - start);
    // Route templates only: no identifiers, search terms, bodies or credentials.
    const routePath = req.route?.path;
    const route = typeof routePath === "string" ? routePath :
      Array.isArray(routePath) && routePath.every((p) => typeof p === "string") ? routePath.slice(0, 4).join("|") : "unclassified";
    req.log.info({
      route, method: req.method, durationMs, status: res.statusCode,
      checkouts: timing.checkouts, checkoutMs: Math.round(timing.checkoutMs),
      maxCheckoutMs: Math.round(timing.maxCheckoutMs), stages,
      // Mock-only route suites have no real pool. Request stages and headers
      // remain active there; resource observations require a real runtime.
      poolWaiting: process.env.NODE_ENV === "test" ? undefined : pool.waitingCount,
    }, "API request stages");
  });
  withDbRequestTiming(timing, next);
};

export const recordBodyParsing: RequestHandler = (_req, res, next) => {
  if (res.locals.bodyEndedAt !== undefined) {
    res.locals.performanceStages.jsonParse = Math.round(performance.now() - res.locals.bodyEndedAt);
  }
  next();
};

export async function timeRequestStage<T>(res: import("express").Response, name: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await operation(); }
  finally {
    if (res.locals.performanceStages) {
      res.locals.performanceStages[name] = Math.round(performance.now() - start);
    }
  }
}
