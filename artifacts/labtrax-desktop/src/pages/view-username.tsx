import { useState, type FormEvent } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Logo } from "@/components/Logo";

interface ViewUsernamePageProps {
  token: string;
}

export default function ViewUsernamePage({ token }: ViewUsernamePageProps) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("Please enter your password.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = (await apiFetch("/view-username", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      })) as { username?: string };
      if (result.username) {
        setUsername(result.username);
      } else {
        setError("Failed to retrieve username.");
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.body as { code?: string } | undefined)?.code;
        if (code === "TOKEN_INVALID") {
          setTokenInvalid(true);
        } else {
          setError(err.message || "Failed to verify password.");
        }
      } else {
        setError((err as Error)?.message || "Failed to verify password.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-[420px]">
        <div className="flex justify-center mb-8">
          <Logo size={56} />
        </div>
        <div className="bg-card border border-border rounded-xl shadow-sm p-7">
          {tokenInvalid ? (
            <>
              <div className="mb-6 text-center">
                <h1 className="text-xl font-semibold tracking-tight">Link expired</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  This link is invalid, has expired, or has already been used.
                  Please request a new one from the sign-in page.
                </p>
              </div>
              <a
                href="/"
                className="block w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 text-center leading-10 transition-colors"
              >
                Back to sign in
              </a>
            </>
          ) : username ? (
            <>
              <div className="mb-6 text-center">
                <h1 className="text-xl font-semibold tracking-tight">Your username</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Use this username to sign in to LabTrax.
                </p>
              </div>
              <div
                data-testid="revealed-username"
                className="text-center text-lg font-semibold bg-muted border border-border rounded-md px-4 py-3 mb-6 break-all"
              >
                {username}
              </div>
              <a
                href="/"
                className="block w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 text-center leading-10 transition-colors"
              >
                Sign in
              </a>
            </>
          ) : (
            <>
              <div className="mb-6">
                <h1 className="text-xl font-semibold tracking-tight">View your username</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  For your security, enter your LabTrax password to view your
                  username.
                </p>
              </div>
              <form onSubmit={onSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5">
                    Password
                  </label>
                  <input
                    type="password"
                    autoComplete="current-password"
                    autoFocus
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
                  {submitting ? "Verifying…" : "View username"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
