import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchMe,
  getAuthRestoreStatus,
  login as apiLogin,
  logout as apiLogout,
  completeTwoFactorChallenge as apiCompleteTwoFactor,
  subscribeSession,
  waitForTokenHydration,
  TwoFactorRequiredError,
  type SessionUser,
} from "./api";

import type { AuthRestoreStatus } from "./auth-restore-status";

interface AuthContextValue {
  user: SessionUser | null;
  status: "loading" | "authed" | "anonymous";
  /** Outcome of the desktop main-process restoring the saved sign-in. */
  restoreStatus: AuthRestoreStatus;
  /** True after the renderer has shown the user the "saved sign-in
   * expired — please sign in again" notice for a decrypt-failed restore.
   * The notice is one-shot per launch. */
  acknowledgeRestoreNotice: () => void;
  restoreNoticeDismissed: boolean;
  /** Throws TwoFactorRequiredError if 2FA is enabled. */
  login: (username: string, password: string) => Promise<void>;
  /** Pass trustDevice=true to remember this device for 30 days. */
  completeTwoFactor: (pendingToken: string, code: string, trustDevice?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<"loading" | "authed" | "anonymous">("loading");
  const [restoreStatus, setRestoreStatus] = useState<AuthRestoreStatus>("empty");
  const [restoreNoticeDismissed, setRestoreNoticeDismissed] = useState(false);

  const verify = useCallback(async () => {
    try {
      // Make sure the encrypted-token hydration has finished before we
      // snapshot the restore status — otherwise the very first read can
      // race past it and report "empty" for a real keychain failure.
      await waitForTokenHydration();
      setRestoreStatus(getAuthRestoreStatus());
      const me = await fetchMe();
      setUser(me);
      setStatus("authed");
    } catch {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const acknowledgeRestoreNotice = useCallback(() => {
    setRestoreNoticeDismissed(true);
  }, []);

  // Tell the Electron iTero poller whether a LabTrax user is signed in.
  // The poller refuses to run when no user is active, so credentials and
  // CSRF tokens are never used outside of an authenticated session.
  useEffect(() => {
    const itero = (typeof window !== "undefined"
      ? (window as { electronAPI?: { itero?: { setAuthState?: (p: { active: boolean }) => unknown } } }).electronAPI
      : null)?.itero;
    if (!itero?.setAuthState) return;
    if (status === "loading") return;
    void itero.setAuthState({ active: status === "authed" });
  }, [status]);

  useEffect(() => {
    void verify();
  }, [verify]);

  // React to session being cleared from anywhere (e.g. failed token refresh).
  useEffect(() => {
    return subscribeSession((next) => {
      if (next === null) {
        setUser(null);
        setStatus("anonymous");
      } else {
        setUser(next);
        setStatus("authed");
      }
    });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const me = await apiLogin(username, password);
    setUser(me);
    setStatus("authed");
  }, []);

  const completeTwoFactor = useCallback(async (pendingToken: string, code: string, trustDevice = false) => {
    const me = await apiCompleteTwoFactor(pendingToken, code, trustDevice);
    setUser(me);
    setStatus("authed");
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      restoreStatus,
      restoreNoticeDismissed,
      acknowledgeRestoreNotice,
      login,
      completeTwoFactor,
      logout,
      refresh: verify,
    }),
    [
      user,
      status,
      restoreStatus,
      restoreNoticeDismissed,
      acknowledgeRestoreNotice,
      login,
      completeTwoFactor,
      logout,
      verify,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
