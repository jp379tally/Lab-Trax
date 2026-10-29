import type { RequestHandler } from "express";
import { isProductionDeployment } from "./onedrive";

/** The connected server owns its database/storage binding; a request cannot change it. */
export function getBackupSourceEnvironment(): "development" | "production" {
  return isProductionDeployment() ? "production" : "development";
}

export const BACKUP_SCHEDULE_INTERVALS_MINUTES = {
  development: [5, 15, 20, 30, 60, 360, 1440, 48 * 60, 72 * 60],
  production: [5, 15, 20, 30, 60, 360, 1440],
} as const;

export function getAllowedBackupScheduleIntervalsMinutes(
  source: "development" | "production" = getBackupSourceEnvironment(),
): readonly number[] {
  return BACKUP_SCHEDULE_INTERVALS_MINUTES[source];
}

export const requireMatchingBackupSource: RequestHandler = (req, res, next) => {
  const source = getBackupSourceEnvironment();
  res.setHeader("X-LabTrax-Backup-Source", source);
  const requested = req.get("X-LabTrax-Backup-Source");
  if (requested && requested !== "development" && requested !== "production") {
    res.status(400).json({ error: "Backup source must be development or production." });
    return;
  }
  if (requested && requested !== source) {
    res.status(409).json({
      error: `Backup source mismatch: requested ${requested}, but this app is connected to ${source}. Open the correct app environment before retrying. No backup or schedule change was started.`,
    });
    return;
  }
  next();
};

/** Interactive app backups always protect production. Explicit operator/CI
 * secrets retain separately labelled non-production export/rehearsal support. */
export const requireProductionApplicationBackup: RequestHandler = (req, res, next) => {
  if (getBackupSourceEnvironment() === "production") return next();
  const operatorSecret = process.env.PLATFORM_ADMIN_SECRET;
  if (operatorSecret && req.get("X-Platform-Admin-Secret") === operatorSecret) return next();
  res.status(403).json({ code: "BACKUP_PRODUCTION_ONLY",
    error: "Application backups protect production records and original files only. Open the production LabTrax app; development data and source exports are separate operator tasks." });
};
