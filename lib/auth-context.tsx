import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface StoredUser {
  username: string;
  password: string;
}

interface AuthContextValue {
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  currentUser: string | null;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  registeredUsers: StoredUser[];
}

const AuthContext = createContext<AuthContextValue | null>(null);

const AUTH_KEY = "@drivesync_auth";
const USERS_STORE_KEY = "@drivesync_auth_users";

const DEFAULT_USERS: StoredUser[] = [
  { username: "admin", password: "admin123" },
  { username: "tech", password: "tech123" },
];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [registeredUsers, setRegisteredUsers] = useState<StoredUser[]>([]);

  useEffect(() => {
    loadAuth();
  }, []);

  async function loadAuth() {
    try {
      const [savedAuth, savedUsers] = await Promise.all([
        AsyncStorage.getItem(AUTH_KEY),
        AsyncStorage.getItem(USERS_STORE_KEY),
      ]);

      if (savedUsers) {
        setRegisteredUsers(JSON.parse(savedUsers));
      } else {
        setRegisteredUsers(DEFAULT_USERS);
        await AsyncStorage.setItem(USERS_STORE_KEY, JSON.stringify(DEFAULT_USERS));
      }

      if (savedAuth) {
        const auth = JSON.parse(savedAuth);
        if (auth.loggedIn && auth.username) {
          setIsAuthenticated(true);
          setCurrentUser(auth.username);
        }
      }
    } catch (e) {
      setRegisteredUsers(DEFAULT_USERS);
    } finally {
      setIsAuthLoading(false);
    }
  }

  async function login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    const users = registeredUsers.length > 0 ? registeredUsers : DEFAULT_USERS;
    const found = users.find(
      (u) => u.username.toLowerCase() === username.toLowerCase() && u.password === password,
    );

    if (!found) {
      return { success: false, error: "Invalid username or password." };
    }

    setIsAuthenticated(true);
    setCurrentUser(found.username);
    await AsyncStorage.setItem(
      AUTH_KEY,
      JSON.stringify({ loggedIn: true, username: found.username }),
    );
    return { success: true };
  }

  function logout() {
    setIsAuthenticated(false);
    setCurrentUser(null);
    AsyncStorage.removeItem(AUTH_KEY);
  }

  const value = useMemo(
    () => ({
      isAuthenticated,
      isAuthLoading,
      currentUser,
      login,
      logout,
      registeredUsers,
    }),
    [isAuthenticated, isAuthLoading, currentUser, registeredUsers],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
