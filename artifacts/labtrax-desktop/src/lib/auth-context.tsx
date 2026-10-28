import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  fetchMe,
  getAuthRestoreStatus,
  installBrowserTabCloseSignOut,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  retrySavedAuthRestore,
  subscribeSession,
  waitForTokenHydration,
  type RegisterPayload,
  type RegisterResult,
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
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<RegisterResult>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateProfilePhoto?: (userId: string, url: string | null) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export type { AuthContextValue };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<"loading" | "authed" | "anonymous">("loading");
  const [restoreStatus, setRestoreStatus] = useState<AuthRestoreStatus>("empty");
  const [restoreNoticeDismissed, setRestoreNoticeDismissed] = useState(false);
  const revision = useRef(0);

  const updateProfilePhoto = useCallback((userId: string, url: string | null) => {
    revision.current++;
    setUser((current) => current?.id === userId ? { ...current, profilePhotoUrl: url } : current);
  }, []);

  const verify = useCallback(async (automaticRestore = false): Promise<void> => {
    const requestRevision = revision.current;
    try {
      // Make sure the encrypted-token hydration has finished before we
      // snapshot the restore status — otherwise the very first read can
      // race past it and report "empty" for a real keychain failure.
      await waitForTokenHydration();
      setRestoreStatus(getAuthRestoreStatus());
      const me = await fetchMe();
      if (requestRevision !== revision.current) return;
      setUser(me);
      setStatus("authed");
    } catch {
      if (requestRevision !== revision.current) return;
      const nextRestoreStatus = getAuthRestoreStatus();
      setRestoreStatus(
        automaticRestore && nextRestoreStatus === "ok"
          ? "restore-failed"
          : nextRestoreStatus,
      );
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

  // Browser sign-in is tab-scoped. On page termination clear local credentials
  // synchronously and best-effort revoke only the current bearer session.
  // Electron uses its encrypted credential bridge and is intentionally skipped.
  useEffect(() => installBrowserTabCloseSignOut(), []);

  // Electron's safeStorage API does not emit keychain-unlocked events. While
  // the login screen is active and the initial restore was blocked, re-check
  // the existing status IPC periodically. The main process returns decrypted
  // credentials only through the existing secure token bridge, never in a
  // notification or log message.
  useEffect(() => {
    if (status !== "anonymous" || restoreStatus !== "keychain-unavailable") {
      return;
    }
    let stopped = false;
    let checking = false;

    const retry = async () => {
      if (checking || stopped) return;
      checking = true;
      try {
        const nextStatus = await retrySavedAuthRestore();
        if (stopped || nextStatus === "keychain-unavailable") return;
        setRestoreStatus(nextStatus);
        if (nextStatus === "ok") {
          await verify(true);
        } else if (nextStatus === "decrypt-failed") {
          setRestoreNoticeDismissed(false);
        }
      } finally {
        checking = false;
      }
    };

    void retry();
    const interval = setInterval(() => void retry(), 5_000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [status, restoreStatus, verify]);

  // React to session being cleared from anywhere (e.g. failed token refresh).
  useEffect(() => {
    return subscribeSession((next) => {
      revision.current++;
      if (next === null) {
        setRestoreStatus(getAuthRestoreStatus());
        setUser(null);
        setStatus("anonymous");
      } else {
        setUser(next);
        setStatus("authed");
      }
    });
  }, []);

  const login = useCallback(async (username: string, password: string, rememberMe = true) => {
    const me = await apiLogin(username, password, rememberMe);
    setUser(me);
    setStatus("authed");
  }, []);

  const register = useCallback(async (payload: RegisterPayload) => {
    const result = await apiRegister(payload);
    setUser(result.user);
    setStatus("authed");
    return result;
  }, []);

  const logout = useCallback(async () => {
    revision.current++;
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
      register,
      logout,
      refresh: verify,
      updateProfilePhoto,
    }),
    [
      user,
      status,
      restoreStatus,
      restoreNoticeDismissed,
      acknowledgeRestoreNotice,
      login,
      register,
      logout,
      verify,
      updateProfilePhoto,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
