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
 * Returns `blocked: true` whenever an admin panel hits a 403 and the platform
 * admin secret is not configured for the current session. This swaps the
 * panel's destructive raw error for a calm "Set this up first" notice.
 *
 * Two contexts trigger the block:
 *   - Desktop (Electron) build: the bridge exists, but the user hasn't saved
 *     the secret to the OS keychain yet → walk them to Settings.
 *   - Web build / Replit preview / any non-Electron browser: there is no
 *     bridge at all, so the secret can't be sent — the panel should show
 *     the same calm notice instead of leaking raw "Admin access required."
 *     errors into the dashboard. The notice copy adapts to that case.
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
  // Block on any 403 from a platform-admin endpoint when the secret is not
  // available for this session — regardless of whether we're running inside
  // Electron (bridge present, secret not yet saved) or in a plain browser
  // (no bridge at all). Previously this was gated on `hasBridge`, which let
  // raw 403s leak through in the web preview.
  const blocked = !configured && has403;
  return { blocked, hasBridge, configured };
}

/**
 * Calm setup-notice block shown in place of the normal admin-panel content
 * when the platform admin secret hasn't been configured for this session.
 * Copy adapts to whether we're running inside Electron (where the secret can
 * be saved to the OS keychain) or a plain browser/web preview (where it
 * cannot, so the user is redirected to use the desktop client).
 */
export function PlatformAdminSetupNotice({
  variant = "block",
}: {
  variant?: "block" | "inline";
}) {
  const hasBridge = !!getBridge();
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
            {hasBridge
              ? "Platform admin secret not configured"
              : "Platform admin tools unavailable in the web view"}
          </div>
          <p className="text-xs text-muted-foreground">
            {hasBridge ? (
              <>
                Platform-wide maintenance endpoints (Media Cleanup, Backup
                schedule, Cleanup alerts) require the deployment&rsquo;s{" "}
                <code className="font-mono">PLATFORM_ADMIN_SECRET</code> to be
                saved on this machine. The secret is encrypted via the OS
                keychain and never leaves this device.
              </>
            ) : (
              <>
                Platform-wide maintenance tools (Media Cleanup, Backup
                schedule, Cleanup alerts) can only run from the LabTrax
                Desktop app, which stores the deployment&rsquo;s{" "}
                <code className="font-mono">PLATFORM_ADMIN_SECRET</code>{" "}
                encrypted in the OS keychain. Open the desktop app and
                configure it under Settings → Platform admin.
              </>
            )}
          </p>
          {hasBridge && (
            <Link
              to="/settings?tab=platform-admin"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              Open Settings → Platform admin
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
