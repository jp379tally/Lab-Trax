/**
 * Persistent backup-staleness banner for lab admins.
 *
 * Backups stopped for eighteen days and the only in-product sign was a small
 * dot on the Settings nav item, next to a "last successful backup" value that
 * came from the database watermark — a figure the dead scheduler never
 * updated and nobody had reason to open. This banner sits above every page
 * and states the age of the archive actually confirmed off-site.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BellOff } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { retryUnlessForbidden } from "@/lib/platform-admin-query";

export interface BackupFreshnessOffsite {
  enabled: boolean;
  stale: boolean;
  ageMinutes: number | null;
  windowMinutes: number;
  intervalMinutes: number;
  source: "onedrive" | "database" | "none";
  reason: string | null;
  destinationUnreadable: boolean;
  newestArchive: {
    name: string;
    createdAt: string;
    sizeBytes: number;
    ageMinutes: number;
  } | null;
}

export interface BackupAlertAttempt {
  at: string;
  channel: "in_app" | "email";
  outcome: "delivered" | "failed";
  recipients: number;
  source: string;
  detail: string | null;
}

export interface BackupOverdueStatus {
  lastSuccessfulBackupAt?: string | null;
  staleAfterDays?: number | null;
  offsite?: BackupFreshnessOffsite | null;
  undeliveredAlert?: BackupAlertAttempt | null;
}

export const BACKUP_OVERDUE_QUERY_KEY = ["admin", "backup-overdue-status"] as const;

const DEFAULT_STALE_DAYS = 7;

/** "4 days 3 hours", "2 hours 10 minutes", "12 minutes". */
export function formatBackupAge(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "an unknown length of time";
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / (60 * 24));
  const hours = Math.floor((total % (60 * 24)) / 60);
  const mins = total % 60;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (days > 0) return hours > 0 ? `${plural(days, "day")} ${plural(hours, "hour")}` : plural(days, "day");
  if (hours > 0) return mins > 0 ? `${plural(hours, "hour")} ${plural(mins, "minute")}` : plural(hours, "hour");
  return plural(mins, "minute");
}

function watermarkStale(lastSuccessfulBackupAt: string | null | undefined, staleDays: number): boolean {
  if (!lastSuccessfulBackupAt) return true;
  const last = new Date(lastSuccessfulBackupAt).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last > staleDays * 24 * 60 * 60 * 1000;
}

export interface BackupFreshnessView {
  loaded: boolean;
  /** Protection has lapsed — show the banner and the nav dot. */
  stale: boolean;
  offsite: BackupFreshnessOffsite | null;
  lastSuccessfulBackupAt: string | null;
  undeliveredAlert: BackupAlertAttempt | null;
}

/**
 * One source of truth for "are we protected right now", shared by the banner
 * and the Settings nav dot. Prefers the confirmed off-site archive; falls
 * back to the database watermark only when off-site protection is switched
 * off (then the seven-day rule is all there is).
 */
export function useBackupFreshness(enabled: boolean): BackupFreshnessView {
  const query = useQuery<BackupOverdueStatus>({
    queryKey: BACKUP_OVERDUE_QUERY_KEY,
    queryFn: () => apiFetch<BackupOverdueStatus>("/admin/backup/overdue-status"),
    enabled,
    retry: retryUnlessForbidden,
    // Short enough that an admin who leaves LabTrax open learns about an
    // outage the same day it starts.
    staleTime: 5 * 60 * 1000,
    refetchInterval: enabled ? 15 * 60 * 1000 : false,
  });

  const data = query.data;
  const offsite = data?.offsite ?? null;
  const stale =
    query.isSuccess &&
    (offsite?.enabled
      ? offsite.stale
      : watermarkStale(data?.lastSuccessfulBackupAt, data?.staleAfterDays ?? DEFAULT_STALE_DAYS));

  return {
    loaded: query.isSuccess,
    stale,
    offsite,
    lastSuccessfulBackupAt: data?.lastSuccessfulBackupAt ?? null,
    undeliveredAlert: data?.undeliveredAlert ?? null,
  };
}

export function BackupStalenessBanner({ view }: { view: BackupFreshnessView }) {
  if (!view.loaded) return null;
  if (!view.stale && !view.undeliveredAlert) return null;

  const offsite = view.offsite;
  const age = offsite?.enabled
    ? offsite.ageMinutes
    : view.lastSuccessfulBackupAt
      ? Math.round((Date.now() - new Date(view.lastSuccessfulBackupAt).getTime()) / 60000)
      : null;
  const headline =
    age === null
      ? "No backup has been confirmed off-site"
      : `No backup has been confirmed off-site for ${formatBackupAge(age)}`;
  const detail =
    offsite?.reason ??
    (view.lastSuccessfulBackupAt
      ? "The last successful backup on record is older than the allowed window."
      : "A successful backup has never been recorded for this lab.");

  return (
    <div className="shrink-0">
      {view.stale && (
        <div
          className="flex items-start gap-2.5 border-b border-destructive/40 bg-destructive/10 px-4 py-2.5 text-destructive dark:text-red-300"
          data-testid="backup-staleness-banner"
          role="alert"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div className="flex-1 text-xs leading-snug">
            <p className="font-semibold">{headline}</p>
            <p className="opacity-90">
              {detail} Your work since then is not protected against losing this server. Open
              Settings → Backup to run one now and check the backup destination.
            </p>
            {offsite?.newestArchive && (
              <p className="mt-0.5 opacity-70">
                Newest archive off-site: {offsite.newestArchive.name}
              </p>
            )}
          </div>
        </div>
      )}
      {view.undeliveredAlert && (
        <div
          className="flex items-start gap-2.5 border-b border-amber-400/50 bg-amber-50 px-4 py-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
          data-testid="backup-alert-undelivered-banner"
          role="alert"
        >
          <BellOff size={15} className="mt-0.5 shrink-0" />
          <div className="flex-1 text-xs leading-snug">
            <p className="font-semibold">A backup alert could not be delivered</p>
            <p className="opacity-90">
              The {view.undeliveredAlert.channel === "email" ? "email" : "in-app"} alert failed
              {view.undeliveredAlert.detail ? `: ${view.undeliveredAlert.detail}` : "."} Until this
              is fixed, a backup outage may go unreported.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
