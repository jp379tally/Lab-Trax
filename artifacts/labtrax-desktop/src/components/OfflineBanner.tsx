import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/lib/use-online-status";

export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 border-b border-amber-200 dark:border-amber-800/50 px-4 py-2 flex items-center gap-2 text-xs"
    >
      <WifiOff size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
      <span>
        <strong>You're offline.</strong> Live data is unavailable — reconnect to continue.
      </span>
    </div>
  );
}
