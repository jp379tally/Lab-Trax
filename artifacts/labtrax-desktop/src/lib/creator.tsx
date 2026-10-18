import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { Loader2, Lock } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { CreatorAccess, CreatorUnlockResult } from "@workspace/api-client-react";

export type { CreatorAccess };
/** Minor-unit aware formatting: digits come from Intl (JPY 0, USD 2, KWD 3). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch { return 2; }
}
export function minorToMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyDigits(currency);
}
export function formatMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minorToMajor(minor, currency));
  } catch { return `${minorToMajor(minor, currency)} ${currency}`; }
}

export const CREATOR_ACCESS_KEY = ["creator", "access"] as const;
export const creatorAccessKey = (userId: string | number | null | undefined) =>
  ["creator", "access", userId ?? "anon"] as const;
export const CREATOR_SETUP_MESSAGE =
  "The Creator PIN has not been provisioned. It is set securely on the server (CREATOR_INITIAL_PIN) and cannot be created from this app. Contact the platform operator, then reload.";
export const PIN_LENGTH = 7;

export function useCreatorAccess() {
  const { user } = useAuth();
  return useQuery<CreatorAccess>({
    queryKey: creatorAccessKey(user?.id),
    queryFn: () => apiFetch<CreatorAccess>("/creator/access"),
    enabled: !!user,
    retry: false,
    staleTime: 30_000,
  });
}

export function creatorErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    const s = err.retryAfter;
    return `Too many attempts. ${s ? `Try again in ${s >= 60 ? Math.ceil(s / 60) + " min" : s + " sec"}.` : "Wait a while before trying again."}`;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

/** 7-digit PIN field. Verifies exactly once when the 7th digit is typed or pasted. */
export function PinField({ onComplete, busy, error, testId = "input-creator-pin" }: {
  onComplete: (pin: string) => void; busy?: boolean; error?: string | null; testId?: string;
}) {
  const [value, setValue] = useState("");
  const submitted = useRef<string | null>(null);
  const cb = useRef(onComplete);
  cb.current = onComplete;
  function change(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, PIN_LENGTH);
    setValue(digits);
    if (digits.length < PIN_LENGTH) { submitted.current = null; return; }
    if (submitted.current === digits) return;
    submitted.current = digits;
    cb.current(digits);
  }
  return (
    <div>
      <input
        data-testid={testId}
        inputMode="numeric"
        type="password"
        autoComplete="off"
        aria-label="Creator PIN"
        autoFocus
        disabled={busy}
        value={value}
        onChange={(e) => change(e.target.value)}
        placeholder="0000000"
        className="h-12 w-full rounded-md border border-border bg-background text-center font-mono text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
      />
      {error && <p role="alert" data-testid="text-creator-pin-error" className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

function isForbidden(err: unknown) {
  return err instanceof ApiError && err.status === 403;
}

/** When any Creator request is refused (expired unlock), re-read capability immediately. */
export function watchCreatorExpiry(qc: QueryClient): () => void {
  const refresh = () => qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY });
  const offQ = qc.getQueryCache().subscribe((e) => {
    if (e.type !== "updated" || e.action.type !== "error" || !isForbidden(e.action.error)) return;
    const k = String(e.query.queryKey[0]);
    if (k === "creator" ? e.query.queryKey[1] !== "access" : k.startsWith("admin-subscription")) void refresh();
  });
  const offM = qc.getMutationCache().subscribe((e) => {
    if (e.type === "updated" && e.action.type === "error" && isForbidden(e.action.error)) void refresh();
  });
  return () => { offQ(); offM(); };
}

export function CreatorGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  useEffect(() => watchCreatorExpiry(qc), [qc]);
  const access = useCreatorAccess();
  const { user } = useAuth();
  const accessKey = creatorAccessKey(user?.id);
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  const expiresAt = access.data?.unlocked ? access.data.expiresAt : null;
  // Idle expiry: re-lock visibly when the server-issued deadline passes, then re-read capability.
  useEffect(() => {
    if (!expiresAt) return;
    const fire = () => { setExpiredFor(expiresAt); void qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY }); };
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) { fire(); return; }
    const t = setTimeout(fire, Math.min(ms, 2_147_000_000));
    return () => clearTimeout(t);
  }, [expiresAt, qc]);
  const [err, setErr] = useState<string | null>(null);
  const submitting = useRef(false);
  const unlock = useMutation({
    mutationFn: (pin: string) => apiFetch<CreatorUnlockResult>("/creator/unlock", { method: "POST", body: JSON.stringify({ pin }) }),
    onSuccess: (r) => {
      setErr(null);
      // Switch immediately, then confirm with the server.
      qc.setQueryData<CreatorAccess>(accessKey, (old) => old ? { ...old, unlocked: true, expiresAt: r?.expiresAt ?? old.expiresAt } : old);
      void qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY });
    },
    onError: (e) => setErr(creatorErrorMessage(e)),
    onSettled: () => { submitting.current = false; },
  });
  useEffect(() => { if (access.data?.unlocked) setErr(null); }, [access.data?.unlocked]);

  if (access.isLoading) {
    return <div className="flex h-48 items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" size={20} /></div>;
  }
  if (access.isError) {
    return (
      <div role="alert" className="m-6 flex items-center gap-3 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
        Could not verify access.
        <button type="button" onClick={() => void access.refetch()} className="rounded border border-destructive/30 px-2 py-1 text-xs">Retry</button>
      </div>
    );
  }
  if (!access.data?.isCreator) return <Redirect to="/" />;
  if (access.data.unlocked && !(expiredFor && expiredFor === access.data.expiresAt)) return <>{children}</>;
  if (!access.data.pinConfigured) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6" data-testid="creator-pin-unprovisioned">
        <div role="alert" className="max-w-sm rounded-lg border border-border bg-card p-5 text-sm">
          <Lock className="mb-2 text-muted-foreground" size={18} />
          {CREATOR_SETUP_MESSAGE}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6" data-testid="creator-gate">
      <div className="w-full max-w-xs text-center">
        <Lock className="mx-auto mb-3 text-muted-foreground" size={22} />
        <h1 className="text-lg font-semibold">Creator console</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">Enter your 7-digit PIN. It verifies automatically.</p>
        <PinField busy={unlock.isPending} error={err} onComplete={(pin) => {
          if (submitting.current) return;
          submitting.current = true;
          unlock.mutate(pin);
        }} />
      </div>
    </div>
  );
}

export function PinSetup() {
  const initial = false;
  const qc = useQueryClient();
  const [f, setF] = useState({ currentPin: "", newPin: "", confirmPin: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const m = useMutation({
    mutationFn: () => apiFetch("/creator/pin", { method: "POST", body: JSON.stringify(f) }),
    onSuccess: () => {
      setMsg({ ok: true, text: "PIN saved. All unlocked sessions were locked." });
      setF({ currentPin: "", newPin: "", confirmPin: "" });
      qc.setQueriesData<CreatorAccess>({ queryKey: CREATOR_ACCESS_KEY }, (old) => old ? { ...old, unlocked: false, expiresAt: null } : old);
      void qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY });
    },
    onError: (e) => setMsg({ ok: false, text: creatorErrorMessage(e) }),
  });
  const valid = /^\d{7}$/.test(f.newPin) && f.newPin === f.confirmPin && (initial || /^\d{7}$/.test(f.currentPin));
  const field = (k: keyof typeof f, label: string) => (
    <label className="block text-left text-xs font-medium text-muted-foreground">{label}
      <input type="password" inputMode="numeric" maxLength={PIN_LENGTH} value={f[k]} data-testid={`input-pin-${k}`}
        onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, "") })}
        className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-primary" />
    </label>
  );
  return (
    <div className={initial ? "flex min-h-[60vh] items-center justify-center p-6" : ""}>
      <div className="w-full max-w-sm space-y-3 rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-semibold">{initial ? "Set your creator PIN" : "Change PIN"}</h2>
        {!initial && field("currentPin", "Current PIN")}
        {field("newPin", "New 7-digit PIN")}
        {field("confirmPin", "Confirm new PIN")}
        {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-emerald-600" : "text-destructive"}`}>{msg.text}</p>}
        <button type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {m.isPending ? "Saving…" : "Save PIN"}
        </button>
      </div>
    </div>
  );
}
