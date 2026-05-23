import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Lock, Loader2, Wrench } from "lucide-react";
import { ApiError, getAccessToken, getApiOrigin } from "@/lib/api";
import {
  getSessionSecret,
  setSessionSecret,
  useSessionSecretVersion,
} from "@/lib/platform-admin-session";
import { useQueryClient } from "@tanstack/react-query";

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
 * Three contexts trigger the block:
 *   - Desktop (Electron) build: the bridge exists, but the user hasn't saved
 *     the secret to the OS keychain yet → walk them to Settings.
 *   - Web build / Replit preview / any non-Electron browser with no session
 *     secret entered → show the "Unlock admin tools" prompt.
 *   - Web build with a session secret already set → secret is injected into
 *     all `/admin/` calls; `configured` is `true` so `blocked` stays `false`.
 */
export function usePlatformAdminGate(errors: Array<unknown>): {
  blocked: boolean;
  hasBridge: boolean;
  configured: boolean;
} {
  const bridge = getBridge();
  const [status, setStatus] = useState<PlatformAdminStatus | null>(null);

  // Re-render whenever the in-memory session secret changes so the gate
  // unblocks immediately after a successful web-view unlock.
  useSessionSecretVersion();

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
  // Configured when: Electron bridge says so, OR the admin has entered a
  // session secret via the web-view unlock modal.
  const configured = !!status?.configured || !!getSessionSecret();
  const blocked = !configured && has403;
  return { blocked, hasBridge, configured };
}

// ---------------------------------------------------------------------------
// Unlock modal
// ---------------------------------------------------------------------------

/**
 * Modal that prompts the admin for the PLATFORM_ADMIN_SECRET. On submit it
 * calls `onUnlock(secret)`; the caller is responsible for verifying and
 * storing the secret (or throwing with a user-facing error message on failure).
 */
export function PlatformAdminUnlockModal({
  onClose,
  onUnlock,
}: {
  onClose: () => void;
  onUnlock: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = pin.trim();
    if (!trimmed) return;
    setIsPending(true);
    setError(null);
    try {
      await onUnlock(trimmed);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Invalid PIN — please try again.",
      );
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl p-6 w-full max-w-sm shadow-lg space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Lock size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold">Enter admin PIN</h2>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Enter your admin PIN to unlock platform admin tools for this
          session. The PIN is only held in memory and is forgotten when you
          refresh the page.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 12))}
            placeholder="Admin PIN"
            className="w-full h-10 px-3 rounded-md border border-input bg-background text-center text-lg tracking-[0.4em] placeholder:text-muted-foreground placeholder:tracking-normal placeholder:text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            autoFocus
            disabled={isPending}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || !pin.trim()}
              className="h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5 transition-colors"
            >
              {isPending && <Loader2 size={12} className="animate-spin" />}
              Unlock
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup notice
// ---------------------------------------------------------------------------

/**
 * Calm setup-notice block shown in place of the normal admin-panel content
 * when the platform admin secret hasn't been configured for this session.
 * Copy adapts to context:
 *   - Electron build: walk the user to Settings → Platform admin.
 *   - Web view / Replit preview: show an "Unlock admin tools" button that
 *     opens a modal prompting for the PLATFORM_ADMIN_SECRET. After a
 *     successful unlock all admin queries are invalidated so the section
 *     retries and renders normally.
 */
export function PlatformAdminSetupNotice({
  variant = "block",
}: {
  variant?: "block" | "inline";
}) {
  const hasBridge = !!getBridge();
  const [showModal, setShowModal] = useState(false);
  const qc = useQueryClient();

  async function handleUnlock(pin: string): Promise<void> {
    const token = getAccessToken();
    const apiOrigin = getApiOrigin();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Platform-Admin-Pin": pin,
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let r: Response;
    try {
      r = await fetch(`${apiOrigin}/api/admin/settings/desktop-installer`, { headers });
    } catch {
      throw new Error("Could not reach the server. Check your connection and try again.");
    }

    if (r.status === 403) {
      throw new Error("Invalid PIN — please try again.");
    }
    if (!r.ok) {
      // Non-403 errors (500, etc.) likely mean the PIN is correct but
      // something else is wrong. Accept it and let the page surface the
      // downstream error rather than blocking the admin entirely.
    }

    setSessionSecret(pin);
    setShowModal(false);
    // Retry all admin queries so the blocked sections load immediately.
    void qc.invalidateQueries({ queryKey: ["admin"] });
    void qc.invalidateQueries({ queryKey: ["admin-subscriptions"] });
  }

  return (
    <>
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
                : "Admin access required"}
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
                  Enter your admin PIN to unlock platform admin tools for this
                  session. The PIN is only held in memory and is forgotten when
                  you refresh the page.
                </>
              )}
            </p>
            {hasBridge ? (
              <Link
                to="/settings?tab=platform-admin"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                Open Settings → Platform admin
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => setShowModal(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <Lock size={11} />
                Enter admin PIN
              </button>
            )}
          </div>
        </div>
      </div>

      {showModal && (
        <PlatformAdminUnlockModal
          onClose={() => setShowModal(false)}
          onUnlock={handleUnlock}
        />
      )}
    </>
  );
}
