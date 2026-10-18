import { useState, useEffect, type FormEvent } from "react";
import { ArrowRight, Clock3, Eye, EyeOff, Smartphone } from "lucide-react";
import {
  classifyAccountNumberInput,
  INVALID_ACCOUNT_NUMBER_MESSAGE,
} from "@workspace/account-number";
import { useAuth } from "@/lib/auth-context";
import { ApiError, apiFetch, getApiOrigin, getRememberMe, saveRememberMe } from "@/lib/api";
import { describeAuthRestoreStatus } from "@/lib/auth-restore-status";
import { Logo } from "@/components/Logo";
import { LoginBrandMark } from "@/components/login-art";
import SignupWizard from "@/components/SignupWizard";

const IDLE_LOGOUT_FLAG = "labtrax_idle_logout_v1";

export default function LoginPage() {
  const {
    login,
    restoreStatus,
    restoreNoticeDismissed,
    acknowledgeRestoreNotice,
  } = useAuth();
  const [mode, setMode] = useState<
    "signin" | "signup" | "forgot-password" | "forgot-username"
  >("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => getRememberMe());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showIdleNotice, setShowIdleNotice] = useState(false);

  // Forgot-password state
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [forgotSuccess, setForgotSuccess] = useState<string | null>(null);
  const [demoResetLink, setDemoResetLink] = useState<string | null>(null);

  // Forgot-username state
  const [forgotUsernameEmail, setForgotUsernameEmail] = useState("");
  const [forgotUsernameLoading, setForgotUsernameLoading] = useState(false);
  const [forgotUsernameError, setForgotUsernameError] = useState<string | null>(null);
  const [forgotUsernameSuccess, setForgotUsernameSuccess] = useState<string | null>(null);
  const [demoRecoveryLink, setDemoRecoveryLink] = useState<string | null>(null);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(IDLE_LOGOUT_FLAG)) {
        sessionStorage.removeItem(IDLE_LOGOUT_FLAG);
        setShowIdleNotice(true);
      }
    } catch {}
  }, []);

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
    const accountInput = classifyAccountNumberInput(username.trim());
    if (accountInput.kind === "new-invalid") {
      setError(INVALID_ACCOUNT_NUMBER_MESSAGE);
      return;
    }
    const loginIdentifier =
      accountInput.kind === "new-valid"
        ? accountInput.normalized
        : username.trim();
    setSubmitting(true);
    setError(null);
    saveRememberMe(rememberMe);
    try {
      await login(loginIdentifier, password, rememberMe);
    } catch (err) {
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

  const apiOrigin = getApiOrigin();
  const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) || "";
  const commitSha = (import.meta.env.VITE_COMMIT_SHA as string | undefined) || "";
  const buildNumber = (import.meta.env.VITE_BUILD_NUMBER as string | undefined) || "";
  const buildLabel = appVersion
    ? `v${appVersion}${buildNumber ? ` (build ${buildNumber})` : ""}${commitSha ? ` · ${commitSha}` : ""}`
    : "";

  async function submitForgotPassword(e: FormEvent) {
    e.preventDefault();
    if (!forgotEmail.trim()) {
      setForgotError("Please enter your email address.");
      return;
    }
    setForgotLoading(true);
    setForgotError(null);
    setForgotSuccess(null);
    setDemoResetLink(null);
    try {
      const result = await apiFetch("/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: forgotEmail.trim() }),
      }) as { message?: string; demoResetLink?: string };
      setForgotSuccess(
        result.message ||
          "If an account with that email exists, a password reset link has been sent.",
      );
      if (result.demoResetLink) {
        setDemoResetLink(result.demoResetLink);
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : (err as Error)?.message || "Failed to process request.";
      setForgotError(message);
    } finally {
      setForgotLoading(false);
    }
  }

  async function submitForgotUsername(e: FormEvent) {
    e.preventDefault();
    if (!forgotUsernameEmail.trim()) {
      setForgotUsernameError("Please enter your email address.");
      return;
    }
    setForgotUsernameLoading(true);
    setForgotUsernameError(null);
    setForgotUsernameSuccess(null);
    setDemoRecoveryLink(null);
    try {
      const result = await apiFetch("/forgot-username", {
        method: "POST",
        body: JSON.stringify({ email: forgotUsernameEmail.trim() }),
      }) as { message?: string; demoRecoveryLink?: string };
      setForgotUsernameSuccess(
        result.message ||
          "If an account with that email exists, a link has been sent.",
      );
      if (result.demoRecoveryLink) {
        setDemoRecoveryLink(result.demoRecoveryLink);
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : (err as Error)?.message || "Failed to process request.";
      setForgotUsernameError(message);
    } finally {
      setForgotUsernameLoading(false);
    }
  }

  if (mode === "signup") {
    return (
      <main className="min-h-screen w-full bg-[#F4F8FC]">
        <div className="grid min-h-screen lg:grid-cols-[43.7fr_56.3fr]">
          <section className="relative hidden min-h-screen overflow-hidden px-[51px] pb-9 pt-[54px] text-white lg:flex lg:flex-col lg:justify-between xl:px-16">
            <img
              src={`${import.meta.env.BASE_URL}brand/signin-reference-background.webp`}
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            />
            <div className="relative z-10">
              <div className="flex items-center gap-[15px]">
                <LoginBrandMark size={54} />
                <div className="flex flex-col leading-none">
                  <span className="text-4xl font-bold tracking-tight">LabTrax</span>
                  <span className="mt-1 text-[10px] uppercase tracking-[0.28em] text-sky-200/70">Lab Operations</span>
                </div>
              </div>
              <div className="ml-1 mt-[clamp(3rem,9.6vh,6rem)] max-w-xl">
                <h1 className="text-[2.6rem] font-bold leading-[1.08] tracking-tight xl:text-[3.2rem]">
                  Built for <span className="text-[#9BDDFB]">Dental</span>{" "}
                  <br />
                  <span className="text-[#9BDDFB]">Professionals</span>
                </h1>
                <p className="mt-3 text-lg font-light text-blue-50/85">
                  Your cases. Your workflow. Connected.
                </p>
              </div>
            </div>
            <div className="relative z-10 ml-1 flex items-center gap-3 text-[9px] font-medium uppercase tracking-[0.28em] text-blue-100/60">
              <span className="h-px w-4 bg-sky-200/70" />
              Lab operations, simplified
            </div>
          </section>

          <section className="flex min-h-screen flex-col items-center justify-center px-4 py-6 sm:px-8 lg:px-12">
            <div className="mb-5 flex w-full max-w-[460px] lg:hidden">
              <Logo size={38} />
            </div>
            <div className="w-full max-w-[460px]">
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
          </section>
        </div>
      </main>
    );
  }

  if (mode === "forgot-password") {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background px-6">
        <div className="w-full max-w-[420px]">
          <div className="flex justify-center mb-8">
            <Logo size={56} />
          </div>
          <div className="bg-card border border-border rounded-xl shadow-sm p-7">
            <div className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Enter the email address associated with your account and we&apos;ll send you a reset link.
              </p>
            </div>
            <form onSubmit={submitForgotPassword} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  className="w-full h-10 px-3 rounded-md bg-background border border-input text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder="you@example.com"
                />
              </div>
              {forgotError && (
                <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {forgotError}
                </div>
              )}
              {forgotSuccess && (
                <div className="text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-md">
                  {forgotSuccess}
                </div>
              )}
              {demoResetLink && (
                <div className="text-xs bg-muted border border-border px-3 py-2 rounded-md break-all">
                  <span className="font-medium">Demo link:</span>{" "}
                  <a href={demoResetLink} className="text-primary hover:underline">
                    {demoResetLink}
                  </a>
                </div>
              )}
              <button
                type="submit"
                disabled={forgotLoading}
                className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {forgotLoading ? "Sending…" : "Send reset link"}
              </button>
            </form>
            <div className="mt-5 pt-4 border-t border-border text-center text-sm text-muted-foreground">
              Remember your password?{" "}
              <button
                type="button"
                onClick={() => {
                  setForgotError(null);
                  setForgotSuccess(null);
                  setMode("signin");
                }}
                className="text-primary font-medium hover:underline"
              >
                Sign in
              </button>
            </div>
          </div>
          {apiOrigin && (
            <p className="text-center text-[10px] text-muted-foreground/70 mt-2 break-all">
              Server: {apiOrigin}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (mode === "forgot-username") {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background px-6">
        <div className="w-full max-w-[420px]">
          <div className="flex justify-center mb-8">
            <Logo size={56} />
          </div>
          <div className="bg-card border border-border rounded-xl shadow-sm p-7">
            <div className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight">Recover your username</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Enter the email address associated with your account and we&apos;ll send you a secure link to view your username.
              </p>
            </div>
            <form onSubmit={submitForgotUsername} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={forgotUsernameEmail}
                  onChange={(e) => setForgotUsernameEmail(e.target.value)}
                  className="w-full h-10 px-3 rounded-md bg-background border border-input text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder="you@example.com"
                />
              </div>
              {forgotUsernameError && (
                <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {forgotUsernameError}
                </div>
              )}
              {forgotUsernameSuccess && (
                <div className="text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-md">
                  {forgotUsernameSuccess}
                </div>
              )}
              {demoRecoveryLink && (
                <div className="text-xs bg-muted border border-border px-3 py-2 rounded-md break-all">
                  <span className="font-medium">Demo link:</span>{" "}
                  <a href={demoRecoveryLink} className="text-primary hover:underline">
                    {demoRecoveryLink}
                  </a>
                </div>
              )}
              <button
                type="submit"
                disabled={forgotUsernameLoading}
                className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {forgotUsernameLoading ? "Sending…" : "Send link"}
              </button>
            </form>
            <div className="mt-5 pt-4 border-t border-border text-center text-sm text-muted-foreground">
              Remember your username?{" "}
              <button
                type="button"
                onClick={() => {
                  setForgotUsernameError(null);
                  setForgotUsernameSuccess(null);
                  setMode("signin");
                }}
                className="text-primary font-medium hover:underline"
              >
                Sign in
              </button>
            </div>
          </div>
          {apiOrigin && (
            <p className="text-center text-[10px] text-muted-foreground/70 mt-2 break-all">
              Server: {apiOrigin}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen w-full bg-[#F4F8FC]">
      <div className="grid min-h-screen lg:grid-cols-[43.7fr_56.3fr]">
        <section className="relative hidden min-h-screen overflow-hidden px-[51px] pb-9 pt-[54px] text-white lg:flex lg:flex-col lg:justify-between xl:px-16">
          <img
            src={`${import.meta.env.BASE_URL}brand/signin-reference-background.webp`}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
          <div className="relative z-10">
            <div className="flex items-center gap-[15px]">
              <LoginBrandMark size={54} />
              <div className="flex flex-col leading-none">
                <span className="text-4xl font-bold tracking-tight">LabTrax</span>
                <span className="mt-1 text-[10px] uppercase tracking-[0.28em] text-sky-200/70">Lab Operations</span>
              </div>
            </div>
            <div className="ml-1 mt-[clamp(3rem,9.6vh,6rem)] max-w-xl">
              <h1 className="text-[2.6rem] font-bold leading-[1.08] tracking-tight xl:text-[3.2rem]">
                Built for <span className="text-[#9BDDFB]">Dental</span>{" "}
                <br />
                <span className="text-[#9BDDFB]">Professionals</span>
              </h1>
              <p className="mt-3 text-lg font-light text-blue-50/85">
                Your cases. Your workflow. Connected.
              </p>
            </div>
          </div>
          <div className="relative z-10 ml-1 flex items-center gap-3 text-[9px] font-medium uppercase tracking-[0.28em] text-blue-100/60">
            <span className="h-px w-4 bg-sky-200/70" />
            Lab operations, simplified
          </div>
        </section>

        <section className="flex min-h-screen flex-col items-center justify-center px-4 py-7 sm:px-8 lg:pl-[60px] lg:pr-12">
          <div className="mb-5 flex w-full max-w-[400px] items-center gap-2.5 lg:hidden">
            <span className="rounded-lg bg-[#0A3E96] p-1"><LoginBrandMark size={32} /></span>
            <span className="text-xl font-semibold text-[#10213D]">LabTrax</span>
          </div>
          <div className="w-full max-w-[405px]">
            <div className="rounded-2xl border border-[#E3EBF5] bg-white shadow-[0_12px_40px_rgba(24,59,99,0.10)]">
              <div className="p-6 sm:px-9 sm:pb-4 sm:pt-8">
                <h2 className="text-[2.05rem] font-extrabold leading-tight tracking-tight text-[#0B1433]">
                  Welcome back
                </h2>
                <p className="mb-2 text-[15px] text-[#5B6F8A]">Sign in to your LabTrax account.</p>
                {showIdleNotice && (
                  <div
                    role="alert"
                    data-testid="idle-logout-notice"
                    className="mb-4 flex items-center gap-2.5 rounded-lg border border-[#D3E3F6] bg-[#E8F1FB] px-3.5 py-2.5 text-[13px] text-[#1B5FB0]"
                  >
                    <Clock3 aria-hidden="true" size={18} className="shrink-0" />
                    <span className="flex-1">You were signed out due to inactivity.</span>
                    <button
                      type="button"
                      onClick={() => setShowIdleNotice(false)}
                      aria-label="Dismiss inactivity notice"
                      className="opacity-70 hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                )}
                {showRestoreToast && restoreNotice && (
                  <div
                    role="alert"
                    data-testid="auth-restore-toast"
                    className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
                  >
                    <span className="flex-1">{restoreNotice.message}</span>
                    <button
                      type="button"
                      onClick={acknowledgeRestoreNotice}
                      aria-label="Dismiss session notice"
                      className="text-amber-900/70 hover:text-amber-900"
                    >
                      ×
                    </button>
                  </div>
                )}
                <form onSubmit={onSubmit} className="space-y-3.5">
                  <div>
                    <label htmlFor="login-username" className="mb-1.5 block text-[13px] font-medium text-[#0B1433]">
                      Username
                    </label>
                    <input
                      id="login-username"
                      type="text"
                      autoComplete="username"
                      autoFocus
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      aria-invalid={Boolean(error)}
                      aria-required="true"
                      className="h-10 w-full rounded-lg border border-[#CFE0F2] bg-white px-3.5 text-sm text-[#10213D] outline-none transition placeholder:text-[#91A1B5] focus:border-[#2878C8] focus:ring-2 focus:ring-[#2878C8]/15"
                      placeholder="Enter your username"
                    />
                  </div>
                  <div>
                    <label htmlFor="login-password" className="mb-1.5 block text-[13px] font-medium text-[#0B1433]">
                      Password
                    </label>
                    <div className="flex h-10 items-center rounded-lg border border-[#CFE0F2] bg-white pr-2 transition focus-within:border-[#2878C8] focus-within:ring-2 focus-within:ring-[#2878C8]/15">
                      <input
                        id="login-password"
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        aria-invalid={Boolean(error)}
                        aria-required="true"
                        className="h-full min-w-0 flex-1 rounded-lg bg-transparent px-3.5 text-sm text-[#10213D] outline-none placeholder:text-[#91A1B5]"
                        placeholder="Enter your password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((visible) => !visible)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        aria-pressed={showPassword}
                        data-testid="toggle-password-visibility"
                        className="flex h-9 w-9 items-center justify-center rounded-md text-[#60758E] transition hover:text-[#145DA0]"
                      >
                        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </div>
                  <label className="flex w-fit cursor-pointer select-none items-center gap-2.5 pt-0.5">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                      className="h-[18px] w-[18px] cursor-pointer rounded border-[#A8B9CD] accent-[#0F62BF]"
                    />
                    <span className="text-[13px] text-[#24364D]">Remember me</span>
                  </label>
                  {error && (
                    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
                      {error}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={submitting}
                    className="relative flex h-11 w-full items-center justify-center rounded-lg bg-[#0B63BF] text-sm font-semibold text-white transition hover:bg-[#0A55A6] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? "Signing in…" : "Sign in"}
                    {!submitting && <ArrowRight aria-hidden="true" size={17} className="absolute right-4" />}
                  </button>
                </form>
                <div className="mt-4 flex items-center justify-center gap-5 text-[13px]">
                  <button
                    type="button"
                    onClick={() => {
                      setForgotUsernameEmail("");
                      setForgotUsernameError(null);
                      setForgotUsernameSuccess(null);
                      setDemoRecoveryLink(null);
                      setMode("forgot-username");
                    }}
                    className="text-[#1565C0] hover:underline"
                  >
                    Forgot username?
                  </button>
                  <span aria-hidden="true" className="h-1 w-1 rounded-full bg-[#5B6F8A]" />
                  <button
                    type="button"
                    onClick={() => {
                      setForgotEmail("");
                      setForgotError(null);
                      setForgotSuccess(null);
                      setDemoResetLink(null);
                      setMode("forgot-password");
                    }}
                    className="text-[#1565C0] hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
              </div>
              <div className="mx-6 border-t border-[#E3EBF5] py-4 text-center text-[13px] text-[#5B6F8A] sm:mx-9">
                New to LabTrax?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode("signup");
                  }}
                  className="text-[#1565C0] hover:underline"
                >
                  Create an account
                </button>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-center gap-3 text-xs text-[#5B6F8A]">
              <Smartphone aria-hidden="true" size={18} strokeWidth={1.5} />
              One account for desktop and mobile
            </div>
            {apiOrigin && (
              <p className="mt-3 break-all text-center text-[10px] text-muted-foreground/70">
                Server: {apiOrigin}
              </p>
            )}
            {buildLabel && (
              <p className="mt-1 text-center text-[10px] text-muted-foreground/60">
                Build: {buildLabel}
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
