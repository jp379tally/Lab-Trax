import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Wrench } from "lucide-react";
import { ApiError } from "@/lib/api";

type PlatformAdminStatus = {
  available: boolean;
  configured: boolean;
  savedAt: number | null;
};

type PlatformAdminBridge = {
  getStatus: () => Promise<PlatformAdminStatus>;
  onChanged?: (cb: (s: PlatformAdminStatus) => void) => () => void;
};

function getBridge(): PlatformAdminBridge | null {
  if (typeof window === "undefined") return null;
  return (
    (window as { electronAPI?: { platformAdmin?: PlatformAdminBridge } }).electronAPI
      ?.platformAdmin ?? null
  );
}

/**
 * Returns true if the bridge exists on this build (i.e. the desktop client),
 * the secret is *not* yet configured locally, and at least one of the supplied
 * errors is a 403 from the API. Used by admin panels to swap their normal
 * destructive error for a calm "Set this up first" notice.
 */
export function usePlatformAdminGate(errors: Array<unknown>): {
  blocked: boolean;
  hasBridge: boolean;
  configured: boolean;
} {
  const bridge = getBridge();
  const [status, setStatus] = useState<PlatformAdminStatus | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    bridge.getStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const off = bridge.onChanged?.((s) => setStatus(s));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [bridge]);

  const has403 = errors.some((e) => e instanceof ApiError && e.status === 403);
  const hasBridge = !!bridge;
  const configured = !!status?.configured;
  const blocked = hasBridge && !configured && has403;
  return { blocked, hasBridge, configured };
}

/**
 * Calm setup-notice block shown in place of the normal admin-panel content
 * when the platform admin secret hasn't been configured on this machine.
 */
export function PlatformAdminSetupNotice({
  variant = "block",
}: {
  variant?: "block" | "inline";
}) {
  return (
    <div
      className={`rounded-md border border-border bg-secondary/40 ${
        variant === "block" ? "px-4 py-3" : "px-3 py-2"
      } text-sm`}
    >
      <div className="flex items-start gap-2">
        <Wrench size={14} className="mt-0.5 text-muted-foreground shrink-0" />
        <div className="space-y-1.5 min-w-0">
          <div className="font-medium text-foreground">
            Platform admin secret not configured
          </div>
          <p className="text-xs text-muted-foreground">
            Platform-wide maintenance endpoints (Media Cleanup, Backup schedule,
            Cleanup alerts) require the deployment&rsquo;s{" "}
            <code className="font-mono">PLATFORM_ADMIN_SECRET</code> to be saved
            on this machine. The secret is encrypted via the OS keychain and
            never leaves this device.
          </p>
          <Link
            to="/settings?tab=platform-admin"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            Open Settings → Platform admin
          </Link>
        </div>
      </div>
    </div>
  );
}
