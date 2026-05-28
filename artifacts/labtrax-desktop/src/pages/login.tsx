import { useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth-context";
import { ApiError, TwoFactorRequiredError, getApiOrigin } from "@/lib/api";
import { describeAuthRestoreStatus } from "@/lib/auth-restore-status";
import { Logo } from "@/components/Logo";
import SignupWizard from "@/components/SignupWizard";

export default function LoginPage() {
  const {
    login,
    completeTwoFactor,
    restoreStatus,
    restoreNoticeDismissed,
    acknowledgeRestoreNotice,
  } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Two-factor auth challenge state
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [challengeSubmitting, setChallengeSubmitting] = useState(false);
  const [trustDevice, setTrustDevice] = useState(true);

  // One-shot toast-style notice when the saved sign-in blob couldn't be
  // decrypted. Distinct from the persistent keychain-unavailable banner
  // (which is rendered globally above the login screen).
  const restoreNotice = describeAuthRestoreStatus(restoreStatus);
  const showRestoreToast =
    restoreNotice?.kind === "toast" && !restoreNoticeDismissed;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Please enter your username and password.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      if (err instanceof TwoFactorRequiredError) {
        setPendingToken(err.pendingToken);
        setTotpCode("");
        setUseBackupCode(false);
        setTrustDevice(true);
        setSubmitting(false);
        return;
      }
      const fallback = "Sign in failed.";
      const message = (err as Error)?.message || fallback;
      const isNetworkError =
        (err instanceof ApiError && err.status === 0) ||
        /failed to fetch|network request failed|load failed|networkerror/i.test(
          message,
        );
      setError(
        isNetworkError
          ? message && /tried |without an API server URL/i.test(message)
            ? message
            : "Can't reach the LabTrax server. Check your internet connection and try again."
          : message,
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onChallenge(e: FormEvent) {
    e.preventDefault();
    if (!totpCode.trim()) {
      setError("Please enter your verification code.");
      return;
    }
    if (!pendingToken) return;
    setChallengeSubmitting(true);
    setError(null);
    try {
      await completeTwoFactor(pendingToken, totpCode.trim(), trustDevice);
    } catch (err) {
      const message = (err as Error)?.message || "Invalid code.";
      setError(message);
    } finally {
      setChallengeSubmitting(false);
    }
  }

  const apiOrigin = getApiOrigin();
  const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) || "";
  const commitSha = (import.meta.env.VITE_COMMIT_SHA as string | undefined) || "";
  const buildNumber = (import.meta.env.VITE_BUILD_NUMBER as string | undefined) || "";
  const buildLabel = appVersion
    ? `v${appVersion}${buildNumber ? ` (build ${buildNumber})` : ""}${commitSha ? ` · ${commitSha}` : ""}`
    : "";

  if (mode === "signup" && !pendingToken) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background px-6 py-10">
        <div className="w-full max-w-[460px]">
          <div className="flex justify-center mb-6">
            <Logo size={56} />
          </div>
          <SignupWizard
            onCancel={() => {
              setMode("signin");
              setError(null);
            }}
          />
          {apiOrigin && (
            <p className="text-center text-[10px] text-muted-foreground/70 mt-3 break-all">
              Server: {apiOrigin}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-[420px]">
        <div className="flex justify-center mb-8">
          <Logo size={56} />
        </div>
        <div className="bg-card border border-border rounded-xl shadow-sm p-7">
          {pendingToken ? (
            <>
              <div className="mb-6">
                <h1 className="text-xl font-semibold tracking-tight">Two-factor verification</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  {useBackupCode
                    ? "Enter one of your saved backup codes."
                    : "Enter the 6-digit code from your authenticator app."}
                </p>
              </div>
              {error && (
                <div className="mb-4 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {error}
                </div>
              )}
              <form onSubmit={onChallenge} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5">
                    {useBackupCode ? "Backup code" : "Verification code"}
                  </label>
                  <input
                    type={useBackupCode ? "text" : "text"}
                    inputMode={useBackupCode ? "text" : "numeric"}
                    autoComplete="one-time-code"
                    autoFocus
                    value={totpCode}
                    onChange={(e) => setTotpCode(useBackupCode ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, "").slice(0, 6))}
                    maxLength={useBackupCode ? 20 : 6}
                    placeholder={useBackupCode ? "XXXXXXXXXX" : "000000"}
                    className="w-full h-10 px-3 rounded-md bg-background border border-input text-sm text-center font-mono tracking-widest focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  />
                </div>
                {/* Trust this device checkbox */}
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={trustDevice}
                    onChange={(e) => setTrustDevice(e.target.checked)}
                    className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
                  />
                  <span className="text-sm text-foreground">
                    Trust this device for 30 days
                  </span>
                </label>
                <button
                  type="submit"
                  disabled={challengeSubmitting || !totpCode.trim()}
                  className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {challengeSubmitting ? "Verifying…" : "Verify"}
                </button>
                <div className="flex items-center justify-between text-xs">
                  <button
                    type="button"
                    onClick={() => { setUseBackupCode(!useBackupCode); setTotpCode(""); setError(null); }}
                    className="text-muted-foreground hover:text-foreground underline"
                  >
                    {useBackupCode ? "Use authenticator app" : "Use a backup code instead"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPendingToken(null); setError(null); setTotpCode(""); }}
                    className="text-muted-foreground hover:text-foreground underline"
                  >
                    Back to sign in
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <div className="mb-6">
                <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Welcome back. Use your LabTrax account to continue.
                </p>
              </div>
              {showRestoreToast && restoreNotice && (
                <div
                  role="alert"
                  data-testid="auth-restore-toast"
                  className="mb-4 text-sm text-amber-900 bg-amber-100 border border-amber-200 px-3 py-2 rounded-md flex items-start gap-2"
                >
                  <span className="flex-1">{restoreNotice.message}</span>
                  <button
                    type="button"
                    onClick={acknowledgeRestoreNotice}
                    aria-label="Dismiss"
                    className="text-amber-900/70 hover:text-amber-900"
                  >
                    ×
                  </button>
                </div>
              )}
              <form onSubmit={onSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5">
                    Username
                  </label>
                  <input
                    type="text"
                    autoComplete="username"
                    autoFocus
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full h-10 px-3 rounded-md bg-background border border-input text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    placeholder="username"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5">
                    Password
                  </label>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full h-10 px-3 rounded-md bg-background border border-input text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    placeholder="••••••••"
                  />
                </div>
                {error && (
                  <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {submitting ? "Signing in…" : "Sign in"}
                </button>
              </form>
              <div className="mt-5 pt-4 border-t border-border text-center text-sm text-muted-foreground">
                Don't have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode("signup");
                  }}
                  className="text-primary font-medium hover:underline"
                >
                  Create one
                </button>
              </div>
            </>
          )}
        </div>
        <p className="text-center text-xs text-muted-foreground mt-5">
          The same account works on the LabTrax mobile app.
        </p>
        {apiOrigin && (
          <p className="text-center text-[10px] text-muted-foreground/70 mt-2 break-all">
            Server: {apiOrigin}
          </p>
        )}
        {buildLabel && (
          <p className="text-center text-[10px] text-muted-foreground/60 mt-1">
            Build: {buildLabel}
          </p>
        )}
      </div>
    </div>
  );
}
