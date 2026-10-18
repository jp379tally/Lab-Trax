import type { Request, Response } from "express";

export const MONITORED_SERVICE_ROOTS = [
  "/api",
  "/downloads",
  "/uploads",
  "/cases",
];

/**
 * Replit's deployment monitor probes each public artifact route root. These
 * exact-match responses keep those routing probes healthy without masking
 * missing nested API, download, upload, or case routes.
 */
export function serviceRootHealth(_req: Request, res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ status: "ok" });
}