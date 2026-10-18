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
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
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

  const verify = useCallback(async () => {
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
      revision.current++;
      if (next === null) {
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
