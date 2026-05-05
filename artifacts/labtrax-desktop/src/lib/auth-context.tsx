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
  clearSession,
  fetchMe,
  loadSession,
  login as apiLogin,
  logout as apiLogout,
  saveSession,
  subscribeSession,
  type Session,
  type SessionUser,
} from "./api";

interface AuthContextValue {
  user: SessionUser | null;
  status: "loading" | "authed" | "anonymous";
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [status, setStatus] = useState<"loading" | "authed" | "anonymous">(() =>
    loadSession() ? "loading" : "anonymous",
  );

  const verify = useCallback(async () => {
    const current = loadSession();
    if (!current) {
      setSession(null);
      setStatus("anonymous");
      return;
    }
    try {
      const me = await fetchMe();
      const next: Session = { ...current, user: { ...current.user, ...me } };
      saveSession(next);
      setSession(next);
      setStatus("authed");
    } catch {
      clearSession();
      setSession(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    if (loadSession()) {
      void verify();
    }
  }, [verify]);

  // React to session being cleared from anywhere (e.g. failed token refresh).
  useEffect(() => {
    return subscribeSession((next) => {
      if (next === null) {
        setSession(null);
        setStatus("anonymous");
      } else {
        setSession(next);
        setStatus("authed");
      }
    });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const next = await apiLogin(username, password);
    setSession(next);
    setStatus("authed");
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setSession(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      status,
      login,
      logout,
      refresh: verify,
    }),
    [session, status, login, logout, verify],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
