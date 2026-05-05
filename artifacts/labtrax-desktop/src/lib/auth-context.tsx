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
  login as apiLogin,
  logout as apiLogout,
  subscribeSession,
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
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<"loading" | "authed" | "anonymous">("loading");

  const verify = useCallback(async () => {
    try {
      const me = await fetchMe();
      setUser(me);
      setStatus("authed");
    } catch {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

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

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      login,
      logout,
      refresh: verify,
    }),
    [user, status, login, logout, verify],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
