/**
 * Tracks desktop-installer download interruption events (stream-retry triggered,
 * stream-retry failed) in system_settings so the health panel can surface them
 * to admins without requiring server log access.
 *
 * Storage format — system_settings key: installer_download_interruptions
 * {
 *   "events": [
 *     { "occurredAt": "<ISO>", "kind": "zip"|"exe"|"dmg", "absoluteOffset": 12345, "retryFailed": false }
 *   ]
 * }
 *
 * Only events from the past 24 h are retained. Writes are fire-and-forget so
 * they never block the streaming response.
 *
 * Alert emails are sent via sendDownloadInterruptionAlertEmail when the number
 * of retry-failed events in the past 24 h reaches or exceeds
 * DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD (env var, default 3). A dedup key
 * installer_download_interruption_alert_last suppresses re-alerts within a 1 h
 * window when the failure count is at the same level.
 */
import { db, systemSettings, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { DesktopInstallerKind } from "./desktop-installer-storage.js";
import { sendDownloadInterruptionAlertEmail } from "./mail.js";
import { logger } from "./logger.js";
import { filterEmailsByPref } from "./email-prefs.js";

const SETTING_EVENTS = "installer_download_interruptions";
const SETTING_ALERT_LAST = "installer_download_interruption_alert_last";
export const SETTING_DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD = "download_interruption_alert_threshold";
const WINDOW_MS = 24 * 60 * 60 * 1000;
const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

export interface DownloadInterruptionEvent {
  occurredAt: string;
  kind: DesktopInstallerKind;
  absoluteOffset: number;
  retryFailed: boolean;
}

export interface DownloadInterruptionStats {
  count24h: number;
  retryFailCount24h: number;
  lastOccurredAt: string | null;
}

interface StoredEvents {
  events: DownloadInterruptionEvent[];
}

interface AlertRecord {
  sentAt: string;
  retryFailCount: number;
}

async function readEvents(): Promise<DownloadInterruptionEvent[]> {
  try {
    const rows = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_EVENTS));
    if (!rows[0]?.value) return [];
    const parsed = JSON.parse(rows[0].value) as StoredEvents;
    if (!Array.isArray(parsed?.events)) return [];
    return parsed.events;
  } catch {
    return [];
  }
}

async function writeEvents(events: DownloadInterruptionEvent[]): Promise<void> {
  const payload = JSON.stringify({ events });
  await db
    .insert(systemSettings)
    .values({ key: SETTING_EVENTS, value: payload })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: payload, updatedAt: new Date() },
    });
}

function pruneToWindow(events: DownloadInterruptionEvent[]): DownloadInterruptionEvent[] {
  const cutoff = Date.now() - WINDOW_MS;
  return events.filter((e) => Date.parse(e.occurredAt) >= cutoff);
}

async function alertThreshold(): Promise<number> {
  try {
    const rows = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD));
    const raw = rows[0]?.value;
    if (raw) {
      const v = parseInt(raw, 10);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch {
    // fall through to env var
  }
  const v = parseInt(process.env.DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

async function maybeFireAlert(events: DownloadInterruptionEvent[]): Promise<void> {
  const threshold = await alertThreshold();
  const retryFailCount = events.filter((e) => e.retryFailed).length;
  if (retryFailCount < threshold) return;

  try {
    const rows = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_ALERT_LAST));
    if (rows[0]?.value) {
      const last = JSON.parse(rows[0].value) as AlertRecord;
      if (typeof last?.sentAt === "string" && typeof last?.retryFailCount === "number") {
        const ageMs = Date.now() - Date.parse(last.sentAt);
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ALERT_DEDUP_WINDOW_MS && last.retryFailCount >= retryFailCount) {
          return;
        }
      }
    }
  } catch {
    // best-effort dedup check
  }

  let adminEmails: string[] = [];
  try {
    const admins = await db.select({ email: users.email }).from(users).where(eq(users.role, "admin"));
    const raw = admins.map((u) => u.email).filter((e): e is string => Boolean(e));
    adminEmails = await filterEmailsByPref(raw, "installerAlerts");
  } catch (err) {
    logger.warn({ err }, "download-interruptions: failed to load admin emails");
  }
  if (adminEmails.length === 0) return;

  const sorted = events.slice().sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  const lastOccurredAt = sorted[0]?.occurredAt ?? new Date().toISOString();

  try {
    await sendDownloadInterruptionAlertEmail({
      adminEmails,
      retryFailCount,
      totalCount: events.length,
      windowHours: 24,
      threshold,
      lastOccurredAt,
    });

    const payload = JSON.stringify({ sentAt: new Date().toISOString(), retryFailCount });
    await db
      .insert(systemSettings)
      .values({ key: SETTING_ALERT_LAST, value: payload })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: payload, updatedAt: new Date() },
      });
  } catch (err) {
    logger.warn({ err }, "download-interruptions: failed to send alert email");
  }
}

/**
 * Record a download interruption event. Fire-and-forget — never throws so it
 * never blocks or crashes the streaming response.
 */
export function recordDownloadInterruption(
  event: Omit<DownloadInterruptionEvent, "occurredAt">,
): void {
  const full: DownloadInterruptionEvent = { ...event, occurredAt: new Date().toISOString() };
  void (async () => {
    try {
      const existing = await readEvents();
      const pruned = pruneToWindow([...existing, full]);
      await writeEvents(pruned);
      await maybeFireAlert(pruned);
    } catch (err) {
      logger.warn({ err }, "download-interruptions: failed to record event");
    }
  })();
}

/**
 * Read the current interruption stats for the past 24 h. Never throws.
 */
export async function getDownloadInterruptionStats(): Promise<DownloadInterruptionStats> {
  try {
    const events = pruneToWindow(await readEvents());
    const retryFailCount24h = events.filter((e) => e.retryFailed).length;
    const sorted = events.slice().sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
    return {
      count24h: events.length,
      retryFailCount24h,
      lastOccurredAt: sorted[0]?.occurredAt ?? null,
    };
  } catch {
    return { count24h: 0, retryFailCount24h: 0, lastOccurredAt: null };
  }
}
