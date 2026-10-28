import { useRef, useState } from "react";
import { useVerifyAdminPin } from "@workspace/api-client-react";
import { KeyRound, Loader2 } from "lucide-react";
import { setSessionSecret } from "@/lib/platform-admin-session";

const PIN_GATED_ADMIN_TABS = new Set([
  "users",
  "backup",
  "mobile",
  "itero",
  "platform-admin",
  "invoice-layout",
  "statement-layout",
  "statement-email",
  "payment-receipt",
  "card-authorization",
  "autopay-authorization",
  "correspondence-layout",
  "deleted-cases",
  "deletion-audit",
  "vocabulary",
  "ai-assistant",
  "doctor-practice-memory",
  "closed-days",
  "employee-hours",
  "permission-outline",
]);

export function requiresAdminSettingsPin(tab: string, isAdmin: boolean): boolean {
  return isAdmin && PIN_GATED_ADMIN_TABS.has(tab);
}

export function AdminSettingsPinGate() {
  const verifyAdminPin = useVerifyAdminPin();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const requestInFlight = useRef(false);

  async function submit(candidate: string) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setError("");
    try {
      await verifyAdminPin.mutateAsync({ data: { pin: candidate } });
      // The desktop session module is memory-only and is also used for admin API requests.
      setSessionSecret(candidate);
      setPin("");
    } catch (failure) {
      const status = (failure as { status?: number })?.status;
      setError(
        status === 403
          ? "Incorrect PIN. Try again."
          : "Could not verify the PIN. Check your connection and try again.",
      );
      setPin("");
    } finally {
      requestInFlight.current = false;
    }
  }

  return (
    <div className="p-6 space-y-4 max-w-md" data-testid="admin-settings-pin-gate">
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-muted-foreground" />
        <h2 className="text-sm font-semibold">Admin PIN required</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Enter your four-digit admin PIN to open this settings panel.
      </p>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={4}
        value={pin}
        disabled={verifyAdminPin.isPending}
        onChange={(event) => {
          const next = event.target.value.replace(/\D/g, "").slice(0, 4);
          setPin(next);
          setError("");
          if (next.length === 4) void submit(next);
        }}
        aria-label="Admin PIN"
        data-testid="admin-settings-pin"
        className="w-full max-w-52 h-11 rounded-md border border-input bg-background px-3 text-center text-lg font-mono tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
      {verifyAdminPin.isPending && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" data-testid="admin-settings-pin-pending">
          <Loader2 size={13} className="animate-spin" />
          Verifying PIN…
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert" data-testid="admin-settings-pin-error">
          {error}
        </p>
      )}
    </div>
  );
}
