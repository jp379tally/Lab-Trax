import { useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api";
import { Logo } from "@/components/Logo";

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      const fallback = "Sign in failed.";
      const message = (err as Error)?.message || fallback;
      // A bare browser-level "Failed to fetch" / "Network request failed"
      // / "Load failed" means the request never reached the server. Replace
      // those with a clearer message so users don't think their password is
      // wrong. Server-returned errors (invalid credentials, locked account,
      // etc.) come through ApiError with a non-zero status and flow through
      // unchanged.
      const isNetworkError =
        (err instanceof ApiError && err.status === 0) ||
        /failed to fetch|network request failed|load failed|networkerror/i.test(
          message,
        );
      setError(
        isNetworkError
          ? "Can't reach the LabTrax server. Check your internet connection and try again."
          : message,
      );
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
          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Welcome back. Use your LabTrax account to continue.
            </p>
          </div>
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
        </div>
        <p className="text-center text-xs text-muted-foreground mt-5">
          The same account works on the LabTrax mobile app.
        </p>
      </div>
    </div>
  );
}
