import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Lock, Loader2, Wrench, RotateCcw, ShieldCheck } from "lucide-react";
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

export function usePlatformAdminGate(errors: Array<unknown>): {
  blocked: boolean;
  hasBridge: boolean;
  configured: boolean;
} {
  const bridge = getBridge();
  const [status, setStatus] = useState<PlatformAdminStatus | null>(null);
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
  const configured = !!status?.configured || !!getSessionSecret();
  const blocked = !configured && has403;
  return { blocked, hasBridge, configured };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiCall(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, string>,
  pin?: string,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const token = getAccessToken();
  const apiOrigin = getApiOrigin();
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (pin) headers["X-Platform-Admin-Pin"] = pin;

  const r = await fetch(`${apiOrigin}/api/${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data: data as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// PIN input — 4 separate boxes
// ---------------------------------------------------------------------------

function PinBoxes({
  label,
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const refs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];

  function handleKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !value[i] && i > 0) {
      refs[i - 1].current?.focus();
      onChange(value.slice(0, i - 1));
    }
  }

  function handleChange(i: number, ch: string) {
    const digit = ch.replace(/\D/g, "").slice(-1);
    if (!digit) return;
    const next = (value.slice(0, i) + digit + value.slice(i + 1)).slice(0, 4);
    onChange(next);
    if (i < 3) refs[i + 1].current?.focus();
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <input
            key={i}
            ref={refs[i]}
            type="password"
            inputMode="numeric"
            maxLength={1}
            value={value[i] ?? ""}
            autoFocus={autoFocus && i === 0}
            disabled={disabled}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKey(i, e)}
            className="w-11 h-12 text-center text-xl font-mono rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SetPinModal — force new PIN after default / after reset
// ---------------------------------------------------------------------------

function SetPinModal({
  currentPin,
  onDone,
}: {
  currentPin: string;
  onDone: (newPin: string) => void;
}) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pin.length !== 4) { setError("Enter all 4 digits."); return; }
    if (pin !== confirm) { setError("PINs don't match — try again."); return; }
    setIsPending(true);
    setError(null);
    const { ok, data } = await apiCall("admin/pin/set", "POST", { currentPin, newPin: pin });
    setIsPending(false);
    if (!ok) { setError((data.error as string) ?? "Could not save PIN."); return; }
    onDone(pin);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border border-border rounded-xl p-6 w-full max-w-sm shadow-lg space-y-5">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">Set your admin PIN</h2>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Choose a unique 4-digit PIN. You&rsquo;ll use it to unlock admin tools.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <PinBoxes label="New PIN" value={pin} onChange={setPin} disabled={isPending} autoFocus />
          <PinBoxes label="Confirm PIN" value={confirm} onChange={setConfirm} disabled={isPending} />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={isPending || pin.length !== 4 || confirm.length !== 4}
            className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5 transition-colors"
          >
            {isPending && <Loader2 size={13} className="animate-spin" />}
            Save PIN
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ForgotPinModal — SMS verification → reset → then triggers SetPinModal
// ---------------------------------------------------------------------------

function ForgotPinModal({
  onClose,
  onReset,
}: {
  onClose: () => void;
  onReset: () => void;
}) {
  type Stage = "sending" | "enter-code" | "error";
  const [stage, setStage] = useState<Stage>("sending");
  const [maskedPhone, setMaskedPhone] = useState<string>("");
  const [code, setCode] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function send() {
      const { ok, data } = await apiCall("admin/pin/forgot", "POST");
      if (cancelled) return;
      if (!ok) { setError((data.error as string) ?? "Failed to send code."); setStage("error"); return; }
      setMaskedPhone((data.maskedPhone as string) ?? "");
      setStage("enter-code");
    }
    send();
    return () => { cancelled = true; };
  }, []);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return;
    setIsPending(true);
    setError(null);
    const { ok, data } = await apiCall("admin/pin/verify-reset", "POST", { code });
    setIsPending(false);
    if (!ok) { setError((data.error as string) ?? "Incorrect code — try again."); return; }
    onReset();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl p-6 w-full max-w-sm shadow-lg space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <RotateCcw size={15} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold">Reset admin PIN</h2>
        </div>

        {stage === "sending" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 size={14} className="animate-spin shrink-0" />
            Sending verification code…
          </div>
        )}

        {stage === "error" && (
          <div className="space-y-3">
            <p className="text-xs text-destructive">{error}</p>
            <button type="button" onClick={onClose} className="h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary transition-colors">
              Close
            </button>
          </div>
        )}

        {stage === "enter-code" && (
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              A 6-digit code was sent to <span className="font-medium text-foreground">{maskedPhone}</span>.
              Enter it below to reset your PIN.
            </p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              autoFocus
              disabled={isPending}
              className="w-full h-10 px-3 rounded-md border border-input bg-background text-center text-2xl tracking-[0.5em] placeholder:text-muted-foreground placeholder:text-base placeholder:tracking-normal focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={onClose} className="h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary transition-colors">
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending || code.length !== 6}
                className="h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5 transition-colors"
              >
                {isPending && <Loader2 size={12} className="animate-spin" />}
                Verify
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unlock modal
// ---------------------------------------------------------------------------

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
  const [showForgot, setShowForgot] = useState(false);
  const [showSetPin, setShowSetPin] = useState(false);
  const [unlockedPin, setUnlockedPin] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = pin.trim();
    if (!trimmed) return;
    setIsPending(true);
    setError(null);
    try {
      await onUnlock(trimmed);
      // Check if still on default PIN — if so, prompt to change
      const { ok, data } = await apiCall("admin/pin/status", "GET", undefined, trimmed);
      if (ok && (data as { isDefault?: boolean }).isDefault) {
        setUnlockedPin(trimmed);
        setShowSetPin(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid PIN — please try again.");
    } finally {
      setIsPending(false);
    }
  }

  if (showSetPin) {
    return (
      <SetPinModal
        currentPin={unlockedPin}
        onDone={(newPin) => {
          setSessionSecret(newPin);
          onClose();
        }}
      />
    );
  }

  if (showForgot) {
    return (
      <ForgotPinModal
        onClose={() => setShowForgot(false)}
        onReset={() => {
          setShowForgot(false);
          setShowSetPin(true);
          setUnlockedPin("0000");
        }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl p-6 w-full max-w-sm shadow-lg space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Lock size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold">Enter admin PIN</h2>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Enter your admin PIN to unlock platform admin tools for this session.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <PinBoxes label="" value={pin} onChange={setPin} disabled={isPending} autoFocus />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowForgot(true)}
              className="text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              Forgot PIN?
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending || pin.length !== 4}
                className="h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5 transition-colors"
              >
                {isPending && <Loader2 size={12} className="animate-spin" />}
                Unlock
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup notice
// ---------------------------------------------------------------------------

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

    setSessionSecret(pin);
    setShowModal(false);
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
              {hasBridge ? "Platform admin secret not configured" : "Admin access required"}
            </div>
            <p className="text-xs text-muted-foreground">
              {hasBridge ? (
                <>
                  Platform-wide maintenance endpoints require the deployment&rsquo;s{" "}
                  <code className="font-mono">PLATFORM_ADMIN_SECRET</code> to be saved on this machine.
                </>
              ) : (
                <>Enter your admin PIN to unlock platform admin tools for this session.</>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={() => setShowModal(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <Lock size={11} />
                Enter admin PIN
              </button>
              {hasBridge && (
                <Link
                  to="/settings?tab=platform-admin"
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary hover:underline"
                >
                  Or paste full secret in Settings
                </Link>
              )}
            </div>
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
