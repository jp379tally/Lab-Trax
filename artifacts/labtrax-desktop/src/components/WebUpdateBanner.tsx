import { useState } from "react";
import { Clock, RefreshCw, X } from "lucide-react";
import { useWebUpdate } from "@/hooks/useWebUpdate";

export function WebUpdateBanner() {
  const updateAvailable = useWebUpdate();
  const [dismissed, setDismissed] = useState(false);
  const [snoozeUntil, setSnoozeUntil] = useState<number | null>(null);

  if (!updateAvailable) return null;
  if (dismissed) return null;
  if (snoozeUntil !== null && Date.now() < snoozeUntil) return null;

  function handleReload() {
    window.location.reload();
  }

  function handleSnooze() {
    setSnoozeUntil(Date.now() + 60 * 60 * 1000);
  }

  function handleDismiss() {
    setDismissed(true);
  }

  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-primary/10 border-b border-primary/20 text-sm">
      <RefreshCw size={14} className="text-primary shrink-0" />
      <span className="text-primary font-medium flex-1">
        A new version of LabTrax is available.
      </span>
      <button
        type="button"
        onClick={handleReload}
        className="shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors"
      >
        <RefreshCw size={12} />
        Reload now
      </button>
      <button
        type="button"
        onClick={handleSnooze}
        title="Remind me in 1 hour"
        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-primary/70 text-xs hover:bg-primary/10 hover:text-primary transition-colors"
      >
        <Clock size={12} />
        1 hr
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        title="Dismiss"
        aria-label="Dismiss update banner"
        className="shrink-0 p-1 rounded-md text-primary/60 hover:bg-primary/10 hover:text-primary transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
