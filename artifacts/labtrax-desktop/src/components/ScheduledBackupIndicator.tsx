import { useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import {
  backupLiveMediaText,
  backupLivePhaseLabel,
  backupLiveProgressText,
  getScheduledLocalBackupProgress,
  subscribeScheduledLocalBackupProgress,
} from "@/lib/local-backup-progress";

export function ScheduledBackupIndicator() {
  const progress = useSyncExternalStore(
    subscribeScheduledLocalBackupProgress,
    getScheduledLocalBackupProgress,
    getScheduledLocalBackupProgress,
  );

  if (!progress) return null;

  const liveStatus = progress.liveStatus;
  const phase =
    liveStatus &&
    (liveStatus.state === "running" || liveStatus.state === "awaiting_verification")
      ? backupLivePhaseLabel(liveStatus.phase)
      : progress.phase;
  const metrics = liveStatus
    ? [backupLiveProgressText(liveStatus), backupLiveMediaText(liveStatus)]
        .filter((value): value is string => value !== null)
        .join(" · ")
    : "";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="scheduled-backup-indicator"
      className="min-w-0 max-w-[min(48vw,32rem)] rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-[11px] leading-tight text-muted-foreground"
      title={[`Scheduled Desktop backup: ${phase}`, metrics].filter(Boolean).join(" · ")}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Loader2 size={13} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
        <span className="shrink-0 font-semibold text-foreground">Backup</span>
        <span className="min-w-0 truncate">{phase}</span>
      </div>
      {metrics && <div className="truncate pl-[19px] tabular-nums">{metrics}</div>}
    </div>
  );
}
